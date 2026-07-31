import { describe, it, expect } from "vitest";
import { classifyImportFile, type ImportKind } from "../src/import-files";

// {name, type} stands in for a DOM File - classifyImportFile only reads these two fields.
const f = (name: string, type = ""): { name: string; type: string } => ({ name, type });

describe("classifyImportFile: every accepted extension routes to its dispatch branch", () => {
  const cases: Array<[string, ImportKind]> = [
    ["scene.glb", "glb"],
    ["scene.gltf", "gltf"],
    ["model.obj", "obj"],
    ["loop.gif", "gif"],
    ["clip.mp4", "video"],
    ["clip.webm", "video"],
    ["clip.mov", "video"],
    ["clip.m4v", "video"],
    ["art.png", "image"],
    ["photo.jpg", "image"],
    ["photo.jpeg", "image"],
    ["sprite.webp", "image"],
    ["scan.bmp", "image"],
    ["shot.avif", "image"],
  ];
  it("maps each extension to its kind", () => {
    for (const [name, kind] of cases) expect(classifyImportFile(f(name)), name).toBe(kind);
  });

  it("is case-insensitive (finder-renamed / shouty files still route)", () => {
    for (const [name, kind] of cases) expect(classifyImportFile(f(name.toUpperCase())), name).toBe(kind);
  });

  it("ignores a URL-derived ?query / #fragment after the extension", () => {
    expect(classifyImportFile(f("loop.gif?width=800"))).toBe("gif");
    expect(classifyImportFile(f("clip.mp4?t=3#frag"))).toBe("video");
    expect(classifyImportFile(f("scene.glb#node"))).toBe("glb");
    expect(classifyImportFile(f("art.png?v=2"))).toBe("image");
  });
});

describe("classifyImportFile: unknown files are unsupported", () => {
  it("rejects unknown extensions", () => {
    for (const name of ["notes.txt", "archive.zip", "scene.fbx", "data.json", "model.stl", "clip.mp3"]) {
      expect(classifyImportFile(f(name)), name).toBe("unsupported");
    }
  });

  it("rejects a missing / extension-less name with no useful MIME", () => {
    expect(classifyImportFile(f("import"))).toBe("unsupported");
    expect(classifyImportFile(f(""))).toBe("unsupported");
    expect(classifyImportFile({})).toBe("unsupported");
    expect(classifyImportFile(f("import", "application/octet-stream"))).toBe("unsupported");
  });
});

describe("classifyImportFile: MIME fallback when the extension is missing", () => {
  // fetchAsFile names a bare-path URL "import" and carries the response Content-Type - the same
  // MIME routes the current dispatch honors (image/gif, video/*, image/*, and the two glTF MIMEs
  // the #v3-import accept attribute already advertises).
  it("routes by Content-Type exactly like the dispatch", () => {
    expect(classifyImportFile(f("import", "image/gif"))).toBe("gif");
    expect(classifyImportFile(f("import", "video/mp4"))).toBe("video");
    expect(classifyImportFile(f("import", "video/webm"))).toBe("video");
    expect(classifyImportFile(f("import", "image/png"))).toBe("image");
    expect(classifyImportFile(f("import", "image/jpeg"))).toBe("image");
    expect(classifyImportFile(f("import", "model/gltf-binary"))).toBe("glb");
    expect(classifyImportFile(f("import", "model/gltf+json"))).toBe("gltf");
  });

  it("gif beats the generic still-image branch (dispatch order)", () => {
    expect(classifyImportFile(f("loop.gif", "image/png"))).toBe("gif");
    expect(classifyImportFile(f("import", "image/gif"))).toBe("gif");
  });

  it("a known extension wins over a conflicting MIME (models are extension-routed)", () => {
    expect(classifyImportFile(f("model.obj", "image/png"))).toBe("obj");
    expect(classifyImportFile(f("scene.glb", "application/octet-stream"))).toBe("glb");
  });
});
