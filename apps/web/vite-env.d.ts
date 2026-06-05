/// <reference types="vite/client" />

declare module "@mineworld/palette/data/*.json" {
  const value: import("@mineworld/palette").MapPalette;
  export default value;
}
