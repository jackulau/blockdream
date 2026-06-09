package world.blockdream;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Entry point for the blockdream Map Wall mod. Two modes, auto-selected at server start:
 *
 *  1. STATIC playback — plays a precomputed block-art video on a wall of filled maps by
 *     rewriting each map's 16384-byte color array every {@code speedTicks} (frames.bin).
 *
 *  2. LIVE world-model control — if {@code <world>/blockdream/live.json} exists, the mod
 *     connects to the neural world-model server over WebSocket, derives a VPT-style action
 *     from the controlling player's per-tick movement (a STOCK vanilla client — no client
 *     mod needed), sends it, and paints each returned frame onto the map wall. The player
 *     literally walks around and the model's predicted world streams onto the wall in front
 *     of them. See WorldModelClient + InputCapture; the data pipeline is proven headless in
 *     packages/cli/src/control-sim.ts.
 *
 *  live.json: {"url":"ws://127.0.0.1:8765","cols":4,"rows":2,"skill":"walk"}
 */
public class BlockdreamMod implements ModInitializer {
    public static final String MOD_ID = "blockdream_mapwall";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    private final MapWallRenderer renderer = new MapWallRenderer();
    private final InputCapture input = new InputCapture();
    private WorldModelClient bridge; // non-null only in live mode
    private String skill;
    private int actionEveryTicks = 1; // send an action this often (1 = every tick = 20 Hz)
    private int actionCounter;
    private boolean bridgeUp; // last surfaced bridge state (server thread only)

    @Override
    public void onInitialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(this::onServerStarted);
        ServerLifecycleEvents.SERVER_STOPPING.register(s -> { if (bridge != null) bridge.shutdown(); });
        ServerTickEvents.END_SERVER_TICK.register(renderer::tick);
        ServerTickEvents.END_SERVER_TICK.register(this::driveLive);
        LOGGER.info("[blockdream] map-wall renderer registered");
    }

    private void onServerStarted(MinecraftServer server) {
        Path live = server.getSavePath(net.minecraft.util.WorldSavePath.ROOT).resolve("blockdream").resolve("live.json");
        if (Files.exists(live)) {
            startLive(server, live);
        } else {
            renderer.load(server); // static frames.bin path
        }
    }

    private void startLive(MinecraftServer server, Path configPath) {
        try {
            JsonObject cfg = JsonParser.parseString(Files.readString(configPath)).getAsJsonObject();
            String url = cfg.has("url") ? cfg.get("url").getAsString() : "ws://127.0.0.1:8765";
            int cols = cfg.has("cols") ? cfg.get("cols").getAsInt() : 1;
            int rows = cfg.has("rows") ? cfg.get("rows").getAsInt() : 1;
            this.skill = cfg.has("skill") ? cfg.get("skill").getAsString() : null;
            if (cfg.has("actionEveryTicks")) this.actionEveryTicks = Math.max(1, cfg.get("actionEveryTicks").getAsInt());

            if (!renderer.loadLive(server, cols, rows)) return;
            MapColorMatcher matcher = MapColorMatcher.loadBundled();
            this.bridge = new WorldModelClient(new URI(url), cols, rows, matcher, renderer);
            bridge.connect();
            LOGGER.info("[blockdream] live control: {} ({}x{} wall, skill={})", url, cols, rows, skill);
        } catch (Exception e) {
            LOGGER.error("[blockdream] failed to start live control", e);
        }
    }

    /** Each tick (in live mode), capture the controlling player's action and send it. */
    private void driveLive(MinecraftServer server) {
        if (bridge == null) return;
        ServerPlayerEntity player = server.getPlayerManager().getPlayerList().stream().findFirst().orElse(null);

        // Surface bridge state transitions (reconnect loop lives in WorldModelClient):
        // a log line + action-bar message when the bridge drops or comes back.
        boolean up = bridge.isConnected();
        if (up != bridgeUp) {
            bridgeUp = up;
            String note = up ? "world-model bridge connected"
                    : "world-model bridge down (" + bridge.stateString() + ")";
            LOGGER.info("[blockdream] {}", note);
            if (player != null) player.sendMessage(Text.literal("[blockdream] " + note), true);
        }
        if (!up) return;

        if (++actionCounter < actionEveryTicks) return;
        actionCounter = 0;
        if (player == null) return;
        String action = input.actionJson(player, skill); // null on the very first tick (no prev pose)
        if (action != null) bridge.sendAction(action);
    }
}
