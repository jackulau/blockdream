package world.blockdream;

import java.io.DataInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Reads the binary frame pool emitted by the blockdream CLI.
 *
 * Format (big-endian):
 *   magic   : 4 bytes  = 'M','W','M','W'
 *   version : int      = 1
 *   cols    : int      (wall width in 128px maps)
 *   rows    : int      (wall height in 128px maps)
 *   frames  : int      (frame count)
 *   speed   : int      (ticks per frame)
 *   data    : frames × cols × rows × 16384 bytes (per-tile map color arrays,
 *             tile order row-major, each frame fully materialized — keyframes,
 *             not deltas, so seeking/looping is O(1))
 */
public final class FramePool {
    public static final int MAP_AREA = 128 * 128; // 16384

    public final int cols;
    public final int rows;
    public final int frameCount;
    public final int speedTicks;
    /** [frame][tile] -> 16384-byte color array */
    public final byte[][][] frames;

    private FramePool(int cols, int rows, int frameCount, int speedTicks, byte[][][] frames) {
        this.cols = cols;
        this.rows = rows;
        this.frameCount = frameCount;
        this.speedTicks = speedTicks;
        this.frames = frames;
    }

    public int tileCount() {
        return cols * rows;
    }

    public static FramePool read(Path path) throws IOException {
        try (DataInputStream in = new DataInputStream(Files.newInputStream(path))) {
            byte[] magic = new byte[4];
            in.readFully(magic);
            if (magic[0] != 'M' || magic[1] != 'W' || magic[2] != 'M' || magic[3] != 'W') {
                throw new IOException("not a blockdream frame pool");
            }
            int version = in.readInt();
            if (version != 1) throw new IOException("unsupported frame pool version " + version);
            int cols = in.readInt();
            int rows = in.readInt();
            int frameCount = in.readInt();
            int speed = in.readInt();
            int tiles = cols * rows;
            byte[][][] frames = new byte[frameCount][tiles][];
            for (int f = 0; f < frameCount; f++) {
                for (int t = 0; t < tiles; t++) {
                    byte[] colors = new byte[MAP_AREA];
                    in.readFully(colors);
                    frames[f][t] = colors;
                }
            }
            return new FramePool(cols, rows, frameCount, Math.max(1, speed), frames);
        }
    }
}
