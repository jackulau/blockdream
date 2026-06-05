package world.mineworld;

import net.minecraft.item.map.MapState;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.world.ServerWorld;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Per-tick map-wall renderer.
 *
 * On server start it loads {@code <world>/mineworld/frames.bin} and resolves the
 * MapState for each configured map id (the operator places those filled maps in
 * a wall of item frames). Every {@code speedTicks} it copies the current frame's
 * color array into each map's {@link MapState#colors} and marks it dirty; the
 * server then streams the updated map packet to all tracking players.
 *
 * NOTE: built against Fabric/Yarn for 1.21.x (operator build, JDK 21). The map
 * id → MapState resolution uses the configured ids in frames.bin's companion
 * {@code maps.txt}; adjust mapping names if targeting a different MC version.
 */
public class MapWallRenderer {
    private FramePool pool;
    private MapState[] tileStates; // length == pool.tileCount()
    private int tickCounter;
    private int frameIndex;
    private boolean active;

    public void load(MinecraftServer server) {
        try {
            ServerWorld overworld = server.getOverworld();
            Path worldDir = server.getSavePath(net.minecraft.util.WorldSavePath.ROOT)
                    .resolve("mineworld");
            Path framesPath = worldDir.resolve("frames.bin");
            if (!Files.exists(framesPath)) {
                MineworldMod.LOGGER.info("[mineworld] no frames.bin found at {} — renderer idle", framesPath);
                return;
            }
            this.pool = FramePool.read(framesPath);
            this.tileStates = resolveTileStates(overworld, worldDir);
            this.active = tileStates != null;
            MineworldMod.LOGGER.info(
                    "[mineworld] loaded {} frames over {}x{} maps @ {} ticks/frame",
                    pool.frameCount, pool.cols, pool.rows, pool.speedTicks);
        } catch (Exception e) {
            MineworldMod.LOGGER.error("[mineworld] failed to load frame pool", e);
            this.active = false;
        }
    }

    /**
     * Resolve the MapState for each wall tile. The companion {@code maps.txt}
     * lists one integer map id per tile (row-major); the operator creates these
     * maps (e.g. via /give) and frames them on the wall. Returns null if the
     * mapping is missing so the renderer stays idle rather than crashing.
     */
    private MapState[] resolveTileStates(ServerWorld world, Path worldDir) throws Exception {
        Path mapsTxt = worldDir.resolve("maps.txt");
        if (!Files.exists(mapsTxt)) {
            MineworldMod.LOGGER.warn("[mineworld] maps.txt missing — cannot bind maps to the wall");
            return null;
        }
        String[] ids = Files.readString(mapsTxt).trim().split("\\s+");
        if (ids.length != pool.tileCount()) {
            MineworldMod.LOGGER.warn("[mineworld] maps.txt has {} ids, expected {}", ids.length, pool.tileCount());
            return null;
        }
        MapState[] states = new MapState[ids.length];
        for (int i = 0; i < ids.length; i++) {
            int mapId = Integer.parseInt(ids[i]);
            MapState state = world.getMapState(new net.minecraft.component.type.MapIdComponent(mapId));
            if (state == null) {
                MineworldMod.LOGGER.warn("[mineworld] map id {} has no MapState yet — create/hold it once first", mapId);
                return null;
            }
            states[i] = state;
        }
        return states;
    }

    /** Called every server tick from {@link MineworldMod}. */
    public void tick(MinecraftServer server) {
        if (!active || pool == null) return;
        if (++tickCounter < pool.speedTicks) return;
        tickCounter = 0;
        frameIndex = (frameIndex + 1) % pool.frameCount;
        applyFrame(frameIndex);
    }

    private void applyFrame(int frame) {
        byte[][] tiles = pool.frames[frame];
        for (int t = 0; t < tileStates.length; t++) {
            MapState state = tileStates[t];
            byte[] colors = tiles[t];
            // Copy the precomputed color array into the live map and flag for resend.
            System.arraycopy(colors, 0, state.colors, 0, FramePool.MAP_AREA);
            state.markDirty();
        }
    }
}
