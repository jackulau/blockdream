package world.blockdream;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.exceptions.WebsocketNotConnectedException;
import org.java_websocket.handshake.ServerHandshake;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.util.Base64;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * WebSocket bridge to the neural world-model server (ml/src/blockdream_wm/serve.py,
 * ws://127.0.0.1:8765). Sends VPT-style action messages and receives generated frames:
 *
 *   send →  {"type":"action","buttons":[9],"camera":[cx,cy],"skill":"walk"}   (or {"type":"reset"})
 *   recv ←  {"type":"frame","png_b64":"…","shape":[3,H,W]}
 *
 * Each received frame is PNG-decoded, scaled to the wall (cols×rows maps of 128px), matched to
 * map colours, and handed to {@link MapWallRenderer#pushLiveFrame} for the next tick to display.
 * This is the live counterpart of the static frames.bin path - same MapState.colors sink.
 *
 * The exact transform (decode → nearest map colour → 128×128 tiles) is proven headless in
 * packages/cli/src/control-sim.ts (frameToMapTiles) + control-sim.test.ts.
 *
 * <h2>Resilience</h2>
 * If the python server dies or restarts, the bridge reconnects automatically with exponential
 * backoff (1s → 2s → 4s … capped at {@value #MAX_BACKOFF_MS} ms), resetting to 1s on success.
 * java-websocket forbids reconnecting from its own read thread, so {@link #onClose}/{@link #onError}
 * only <em>schedule</em> the attempt on a dedicated daemon thread which calls
 * {@link #reconnectBlocking()}. The server tick thread (BlockdreamMod.driveLive) polls
 * {@link #isConnected()} / {@link #stateString()} to surface transitions; all shared state here
 * is atomic/volatile, and an intentional {@link #shutdown()} (server stopping) wins every race
 * with the reconnect loop.
 */
public final class WorldModelClient extends WebSocketClient {
    private static final long INITIAL_BACKOFF_MS = 1_000;
    private static final long MAX_BACKOFF_MS = 30_000;

    private final int cols;
    private final int rows;
    private final MapColorMatcher matcher;
    private final MapWallRenderer renderer;
    private final AtomicReference<String> skill = new AtomicReference<>(null);

    /** Runs reconnect attempts off the websocket threads. Daemon: never blocks JVM exit. */
    private final ScheduledExecutorService reconnector = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "blockdream-wm-reconnect");
        t.setDaemon(true);
        return t;
    });
    private final AtomicBoolean reconnectPending = new AtomicBoolean(false); // dedupes onError→onClose pairs
    private final AtomicBoolean stopped = new AtomicBoolean(false);          // intentional shutdown
    private volatile long backoffMs = INITIAL_BACKOFF_MS;
    private final AtomicReference<String> state = new AtomicReference<>("connecting");

    public WorldModelClient(URI uri, int cols, int rows, MapColorMatcher matcher, MapWallRenderer renderer) {
        super(uri);
        this.cols = cols;
        this.rows = rows;
        this.matcher = matcher;
        this.renderer = renderer;
    }

    public void setSkill(String s) {
        skill.set(s);
    }

    /** True while the socket is open. Safe from the server tick thread. */
    public boolean isConnected() {
        return isOpen();
    }

    /** Human-readable bridge state: "connecting", "connected", "reconnecting in Ns", "stopped". */
    public String stateString() {
        return state.get();
    }

    @Override
    public void onOpen(ServerHandshake h) {
        backoffMs = INITIAL_BACKOFF_MS; // healthy again - next outage starts the ladder over
        state.set("connected");
        BlockdreamMod.LOGGER.info("[blockdream] world-model connected: {}", getURI());
        send("{\"type\":\"reset\"}");
    }

    /** Send a pre-built action message (see InputCapture). Skill is injected if configured. */
    public void sendAction(String actionJson) {
        if (!isOpen()) return;
        try {
            send(actionJson);
        } catch (WebsocketNotConnectedException e) {
            // benign race: socket closed between the isOpen() check and send(); reconnect handles it
        }
    }

    @Override
    public void onMessage(String message) {
        try {
            JsonObject msg = JsonParser.parseString(message).getAsJsonObject();
            if (!msg.has("type") || !"frame".equals(msg.get("type").getAsString())) return;
            String b64 = msg.has("png_b64") ? msg.get("png_b64").getAsString()
                    : msg.has("rgb_png_b64") ? msg.get("rgb_png_b64").getAsString() : null;
            if (b64 == null) return;
            BufferedImage img = ImageIO.read(new ByteArrayInputStream(Base64.getDecoder().decode(b64)));
            if (img != null) renderer.pushLiveFrame(toTiles(img));
        } catch (Exception e) {
            BlockdreamMod.LOGGER.warn("[blockdream] bad frame message", e);
        }
    }

    /** Decode → scale to wall size → per-tile 16384-byte map-colour arrays (row-major). */
    private byte[][] toTiles(BufferedImage src) {
        final int wallW = cols * 128;
        final int wallH = rows * 128;
        byte[][] tiles = new byte[cols * rows][FramePool.MAP_AREA];
        for (int ty = 0; ty < rows; ty++) {
            for (int tx = 0; tx < cols; tx++) {
                byte[] colors = tiles[ty * cols + tx];
                for (int y = 0; y < 128; y++) {
                    for (int x = 0; x < 128; x++) {
                        // nearest-neighbour sample of the source scaled to the wall
                        int sx = (int) ((long) (tx * 128 + x) * src.getWidth() / wallW);
                        int sy = (int) ((long) (ty * 128 + y) * src.getHeight() / wallH);
                        int rgb = src.getRGB(Math.min(sx, src.getWidth() - 1), Math.min(sy, src.getHeight() - 1));
                        colors[y * 128 + x] = matcher.nearest((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
                    }
                }
            }
        }
        return tiles;
    }

    @Override
    public void onClose(int code, String reason, boolean remote) {
        if (stopped.get()) {
            BlockdreamMod.LOGGER.info("[blockdream] world-model disconnected ({}): {}", code, reason);
            return;
        }
        BlockdreamMod.LOGGER.warn("[blockdream] world-model disconnected (code={} remote={}): {}", code, remote, reason);
        scheduleReconnect();
    }

    @Override
    public void onError(Exception ex) {
        BlockdreamMod.LOGGER.warn("[blockdream] world-model socket error: {}", ex.toString());
        scheduleReconnect(); // onClose usually follows; the pending-flag CAS dedupes
    }

    /** Schedule one reconnect attempt after the current backoff, then double it (capped). */
    private void scheduleReconnect() {
        if (stopped.get() || !reconnectPending.compareAndSet(false, true)) return;
        final long delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        state.set("reconnecting in " + Math.max(1, delay / 1000) + "s");
        BlockdreamMod.LOGGER.info("[blockdream] world-model bridge down - reconnecting in {} ms (cap {} ms)", delay, MAX_BACKOFF_MS);
        try {
            reconnector.schedule(this::attemptReconnect, delay, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            reconnectPending.set(false); // shutdown() raced us; stay down
        }
    }

    private void attemptReconnect() {
        reconnectPending.set(false);
        if (stopped.get()) return;
        state.set("connecting");
        BlockdreamMod.LOGGER.info("[blockdream] world-model reconnect attempt: {}", getURI());
        try {
            // Blocking variant is safe here: we are on the dedicated reconnector thread, not a
            // websocket thread. On failure java-websocket fires onClose, which re-schedules with
            // doubled backoff; the extra scheduleReconnect() below is a CAS-deduped safety net.
            if (!reconnectBlocking()) scheduleReconnect();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            BlockdreamMod.LOGGER.warn("[blockdream] reconnect attempt failed: {}", e.toString());
            scheduleReconnect();
        }
    }

    /** Intentional shutdown (server stopping): stop the reconnect loop, then close the socket. */
    public void shutdown() {
        stopped.set(true);
        state.set("stopped");
        reconnector.shutdownNow();
        close();
    }
}
