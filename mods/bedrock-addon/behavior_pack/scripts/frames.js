// EXAMPLE data — regenerate with:  mineworld render <input> --target bedrock-script
// Schema: POOL.frames[f] = array of [x, y, paletteIndex]; frame 0 is a full
// keyframe, later frames are deltas (changed cells only).
export const POOL = {
  height: 2,
  origin: { x: 0, y: 64, z: 0 },
  speedTicks: 4,
  dimension: "overworld",
  autoplay: false,
  palette: ["minecraft:white_concrete", "minecraft:black_concrete"],
  frames: [
    [
      [0, 0, 0],
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, 0],
    ],
    [[1, 1, 1]],
  ],
};
