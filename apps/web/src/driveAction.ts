// Pure keyboard → driving control [steer, throttle, brake]. steer>0 = left.

export function controlFromKeys(keys: Set<string>): [number, number, number] {
  let steer = 0;
  let throttle = 0;
  let brake = 0;
  if (keys.has("arrowleft") || keys.has("a")) steer += 1;
  if (keys.has("arrowright") || keys.has("d")) steer -= 1;
  if (keys.has("arrowup") || keys.has("w")) throttle = 1;
  if (keys.has("arrowdown") || keys.has("s")) brake = 1;
  return [steer, throttle, brake];
}
