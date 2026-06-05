// Pure keyboard → VPT-style action mapping (DOM-free, unit-testable).

export const N_BUTTONS = 9;

export interface Action {
  buttons: number[];
  camera: [number, number];
}

/** Map the set of currently-held (lowercased) keys to a world-model action. */
export function actionFromKeys(keys: Set<string>): Action {
  const b = new Array(N_BUTTONS).fill(0);
  if (keys.has("w")) b[0] = 1; // forward
  if (keys.has("s")) b[1] = 1; // back
  if (keys.has("a")) b[2] = 1; // left
  if (keys.has("d")) b[3] = 1; // right
  if (keys.has(" ")) b[4] = 1; // jump
  if (keys.has("shift")) b[5] = 1; // sneak
  let cx = 0;
  let cy = 0;
  if (keys.has("arrowleft")) cx -= 0.5;
  if (keys.has("arrowright")) cx += 0.5;
  if (keys.has("arrowup")) cy -= 0.5;
  if (keys.has("arrowdown")) cy += 0.5;
  return { buttons: b, camera: [cx, cy] };
}
