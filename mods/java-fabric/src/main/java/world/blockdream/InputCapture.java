package world.blockdream;

import net.minecraft.server.network.ServerPlayerEntity;

/**
 * Derives a VPT-style world-model action from a player's server-observed pose delta - so a
 * player joins with a STOCK vanilla client and just walks/looks to drive the model (no client
 * mixin, no keyboard hook). One instance tracks one controlling player across ticks.
 *
 * This is the JVM twin of packages/cli/src/control-sim.ts {@code deriveAction}, which is
 * unit-tested; keep the two in sync (button order, thresholds, camera scale).
 */
public final class InputCapture {
    // button order - matches control-sim.ts BTN + apps/web action.ts
    private static final int FORWARD = 0, BACK = 1, LEFT = 2, RIGHT = 3, JUMP = 4, SNEAK = 5, SPRINT = 6;
    private static final int N_BUTTONS = 9;
    private static final double MOVE_EPS = 0.02;   // m/tick below which the player is "still"
    private static final double CAMERA_DEG = 12.0; // look-delta degrees → camera magnitude 1.0

    private boolean has;
    private double px, pz, pYaw, pPitch;
    private boolean pOnGround;

    private static double wrapDeg(double d) {
        double x = ((d + 180) % 360 + 360) % 360 - 180;
        return x == -180 ? 180 : x;
    }

    private static double clamp1(double v) {
        return Math.max(-1.0, Math.min(1.0, v));
    }

    /** Build the action JSON for this tick, or null if we don't yet have a previous pose. */
    public String actionJson(ServerPlayerEntity p, String skill) {
        double x = p.getX(), z = p.getZ(), yaw = p.getYaw(), pitch = p.getPitch();
        boolean onGround = p.isOnGround();
        if (!has) {
            has = true;
            px = x; pz = z; pYaw = yaw; pPitch = pitch; pOnGround = onGround;
            return null;
        }

        int[] b = new int[N_BUTTONS];
        double dx = x - px, dz = z - pz;
        double yr = Math.toRadians(yaw);
        double fwdX = -Math.sin(yr), fwdZ = Math.cos(yr);
        double forward = dx * fwdX + dz * fwdZ;     // + = moving the way you face
        double strafe = dx * fwdZ - dz * fwdX;      // + = to your right
        if (forward > MOVE_EPS) b[FORWARD] = 1; else if (forward < -MOVE_EPS) b[BACK] = 1;
        if (strafe > MOVE_EPS) b[RIGHT] = 1; else if (strafe < -MOVE_EPS) b[LEFT] = 1;
        if (!onGround && onGround != pOnGround) b[JUMP] = 1;
        if (p.isSneaking()) b[SNEAK] = 1;
        if (p.isSprinting()) b[SPRINT] = 1;

        double cx = clamp1(wrapDeg(yaw - pYaw) / CAMERA_DEG);
        double cy = clamp1((pitch - pPitch) / CAMERA_DEG);

        px = x; pz = z; pYaw = yaw; pPitch = pitch; pOnGround = onGround;

        StringBuilder sb = new StringBuilder(96);
        sb.append("{\"type\":\"action\",\"buttons\":[");
        for (int i = 0; i < N_BUTTONS; i++) {
            if (i > 0) sb.append(',');
            sb.append(b[i]);
        }
        sb.append("],\"camera\":[").append(round3(cx)).append(',').append(round3(cy)).append(']');
        if (skill != null && !skill.isEmpty()) sb.append(",\"skill\":\"").append(skill).append('"');
        sb.append('}');
        return sb.toString();
    }

    private static String round3(double v) {
        return String.format(java.util.Locale.ROOT, "%.3f", v);
    }
}
