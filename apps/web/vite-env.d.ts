/// <reference types="vite/client" />

declare module "@blockdream/palette/data/*.json" {
  const value: import("@blockdream/palette").MapPalette;
  export default value;
}
