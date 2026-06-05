package world.mineworld;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Entry point for the mineworld Map Wall mod.
 *
 * The mod plays a block-art video on a wall of filled maps by rewriting each
 * map's 16384-byte color array every {@code speedTicks} and marking it dirty,
 * so the server resends the map packet to tracking players. This is the
 * high-FPS path (one array swap per map) that a {@code setblock} wall cannot
 * match for high-motion content.
 *
 * Frame data is produced by the {@code mineworld} CLI and read from
 * {@code <world>/mineworld/frames.bin} (see {@link FramePool}).
 */
public class MineworldMod implements ModInitializer {
    public static final String MOD_ID = "mineworld_mapwall";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    private final MapWallRenderer renderer = new MapWallRenderer();

    @Override
    public void onInitialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(this::onServerStarted);
        ServerTickEvents.END_SERVER_TICK.register(renderer::tick);
        LOGGER.info("[mineworld] map-wall renderer registered");
    }

    private void onServerStarted(MinecraftServer server) {
        renderer.load(server);
    }
}
