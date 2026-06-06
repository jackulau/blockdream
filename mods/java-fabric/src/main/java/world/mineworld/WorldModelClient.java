package world.mineworld;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicReference;

/**
 * WebSocket bridge to the neural world-model server (ml/src/mineworld_wm/serve.py,
 * ws://127.0.0.1:8765). Sends VPT-style action messages and receives generated frames:
 *
 *   send →  {"type":"action","buttons":[9],"camera":[cx,cy],"skill":"walk"}   (or {"type":"reset"})
 *   recv ←  {"type":"frame","png_b64":"…","shape":[3,H,W]}
 *
 * Each received frame is PNG-decoded, scaled to the wall (cols×rows maps of 128px), matched to
 * map colours, and handed to {@link MapWallRenderer#pushLiveFrame} for the next tick to display.
 * This is the live counterpart of the static frames.bin path — same MapState.colors sink.
 *
 * The exact transform (decode → nearest map colour → 128×128 tiles) is proven headless in
 * packages/cli/src/control-sim.ts (frameToMapTiles) + control-sim.test.ts.
 */
public final class WorldModelClient extends WebSocketClient {
    private final int cols;
    private final int rows;
    private final MapColorMatcher matcher;
    private final MapWallRenderer renderer;
    private final AtomicReference<String> skill = new AtomicReference<>(null);

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

    @Override
    public void onOpen(ServerHandshake h) {
        MineworldMod.LOGGER.info("[mineworld] world-model connected: {}", getURI());
        send("{\"type\":\"reset\"}");
    }

    /** Send a pre-built action message (see InputCapture). Skill is injected if configured. */
    public void sendAction(String actionJson) {
        if (!isOpen()) return;
        send(actionJson);
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
            MineworldMod.LOGGER.warn("[mineworld] bad frame message", e);
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
        MineworldMod.LOGGER.info("[mineworld] world-model disconnected ({}): {}", code, reason);
    }

    @Override
    public void onError(Exception ex) {
        MineworldMod.LOGGER.warn("[mineworld] world-model socket error", ex);
    }
}
