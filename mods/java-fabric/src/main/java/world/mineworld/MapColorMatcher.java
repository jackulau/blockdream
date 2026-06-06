package world.mineworld;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Nearest Minecraft map-colour matcher. Loads the canonical palette bundled at
 * {@code /mineworld/map-colors.json} (generated from {@code @mineworld/palette}, the SAME
 * 244-entry table the rest of the toolchain uses) and maps an RGB pixel to its nearest map
 * colour id. This mirrors color-core's nearest-by-distance match used in the headless bridge
 * proof (packages/cli/src/control-sim.ts → frameToMapTiles).
 *
 * Note: ids are stored as bytes; ids &gt; 127 wrap negative, which is exactly what
 * {@link net.minecraft.item.map.MapState#colors} expects (it is a signed byte array).
 */
public final class MapColorMatcher {
    private final int[] ids;
    private final int[] r;
    private final int[] g;
    private final int[] b;

    private MapColorMatcher(int[] ids, int[] r, int[] g, int[] b) {
        this.ids = ids;
        this.r = r;
        this.g = g;
        this.b = b;
    }

    public static MapColorMatcher loadBundled() {
        try (InputStream in = MapColorMatcher.class.getResourceAsStream("/mineworld/map-colors.json")) {
            if (in == null) throw new IllegalStateException("missing /mineworld/map-colors.json resource");
            JsonObject root = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
            JsonArray colors = root.getAsJsonArray("colors");
            int n = colors.size();
            int[] ids = new int[n], r = new int[n], g = new int[n], b = new int[n];
            for (int i = 0; i < n; i++) {
                JsonArray e = colors.get(i).getAsJsonArray(); // [mapColorId, r, g, b]
                ids[i] = e.get(0).getAsInt();
                r[i] = e.get(1).getAsInt();
                g[i] = e.get(2).getAsInt();
                b[i] = e.get(3).getAsInt();
            }
            return new MapColorMatcher(ids, r, g, b);
        } catch (Exception ex) {
            throw new RuntimeException("failed to load map-colors palette", ex);
        }
    }

    /** Nearest map-colour id (as a signed byte, ready for MapState.colors) for an RGB pixel. */
    public byte nearest(int rr, int gg, int bb) {
        int best = 0;
        long bestD = Long.MAX_VALUE;
        for (int i = 0; i < ids.length; i++) {
            long dr = rr - r[i], dg = gg - g[i], db = bb - b[i];
            long d = dr * dr + dg * dg + db * db;
            if (d < bestD) {
                bestD = d;
                best = ids[i];
            }
        }
        return (byte) best; // ids > 127 intentionally wrap negative (signed MapState.colors)
    }
}
