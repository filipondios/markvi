import { expect, test } from "bun:test";
import { createDocs, indexFolders, normalizePath } from "./model.ts";
import { createIndexState, reconcileIndexState } from "./state.ts";

test("normalizePath tolera separadores y prefijos de ruta", () => {
  expect(normalizePath("a/b.md")).toBe("a/b.md");
  expect(normalizePath("a\\b.md")).toBe("a/b.md");
  expect(normalizePath("./a.md")).toBe("a.md");
  expect(normalizePath("/a.md")).toBe("a.md");
  expect(normalizePath("")).toBe("");
});

test("createDocs: orden estable, sin duplicados y con carpeta y nombre", () => {
  const docs = createDocs(["b.md", "a/b.md", "a.md", "b.md", "a\\c.md"]);
  expect(docs.map((doc) => doc.path)).toEqual(["a.md", "a/b.md", "a/c.md", "b.md"]);
  expect(docs[1]).toEqual({ path: "a/b.md", dir: "a", name: "b.md" });
  expect(docs[0]!.dir).toBe("");
});

test("indexFolders devuelve todos los ancestros sin la raíz", () => {
  expect(indexFolders(["a/b/c.md", "d.md", "a/x.md"])).toEqual(
    new Set(["a", "a/b"]),
  );
  expect(indexFolders(["d.md"])).toEqual(new Set());
});

test("la selección sobrevive a un refresco que reordena los documentos", () => {
  const state = { ...createIndexState(), selectedPath: "a/b.md" };
  const next = reconcileIndexState(state, ["z.md", "a/b.md", "a.md"]);
  expect(next.selectedPath).toBe("a/b.md");
  expect(reconcileIndexState(state, ["a/b.md", "a.md", "z.md"]).selectedPath).toBe("a/b.md");
});

test("la selección desaparecida salta al documento cercano: hermano, ancestro, raíz, null", () => {
  const files = ["a/uno.md", "a/sub/dos.md", "raiz.md", "b.md"];
  const base = { ...createIndexState(), selectedPath: "a/sub/dos.md" };

  // Hermano de la misma carpeta.
  expect(reconcileIndexState(base, ["a/uno.md", "raiz.md"]).selectedPath).toBe("a/uno.md");

  // Sin hermanos: el primero de la carpeta ancestro.
  expect(
    reconcileIndexState(base, ["raiz.md", "a/otro.md"]).selectedPath,
  ).toBe("a/otro.md");

  // Sin carpeta ancestro con documentos: el primero global (orden por ruta).
  expect(reconcileIndexState(base, ["raiz.md", "b.md"]).selectedPath).toBe("b.md");

  // Sin documentos: null.
  expect(reconcileIndexState(base, []).selectedPath).toBeNull();
  expect(reconcileIndexState({ ...base, selectedPath: null }, files).selectedPath).toBeNull();
});

test("el foco se conserva si el nodo existe; si no, sube a la carpeta padre válida", () => {
  const files = ["a/b.md", "c.md"];
  const base = { ...createIndexState(), focusedNodeId: "a/b.md" };
  expect(reconcileIndexState(base, files).focusedNodeId).toBe("a/b.md");

  // El documento desapareció pero su carpeta sigue: foco en la carpeta.
  expect(reconcileIndexState(base, ["a/x.md"]).focusedNodeId).toBe("a");

  // Tampoco queda la carpeta: sube hasta una carpeta válida o null.
  expect(reconcileIndexState(base, ["c.md"]).focusedNodeId).toBeNull();
  expect(
    reconcileIndexState({ ...base, focusedNodeId: "a/b/c.md" }, ["a/x.md"]).focusedNodeId,
  ).toBe("a");
});

test("las carpetas expandidas y el preview fijado descartan rutas inexistentes", () => {
  const state = {
    ...createIndexState(),
    expandedPaths: ["a", "borrada", "b"],
    previewPinnedPath: "a/b.md",
  };
  const next = reconcileIndexState(state, ["a/b.md", "c.md"]);
  expect(next.expandedPaths).toEqual(["a"]);
  expect(next.previewPinnedPath).toBe("a/b.md");

  const gone = reconcileIndexState(state, ["c.md"]);
  expect(gone.expandedPaths).toEqual([]);
  expect(gone.previewPinnedPath).toBeNull();
});

test("la reconciliación no toca el filtro ni la vista: el conjunto de documentos es externo", () => {
  const state = { ...createIndexState(), filter: "notas", view: "list" as const };
  const next = reconcileIndexState(state, ["a.md"]);
  expect(next.filter).toBe("notas");
  expect(next.view).toBe("list");
  expect(next.previewVisible).toBe(false);
  // El estado no guarda los documentos: el modelo se reconstruye de /api/tree.
  expect("docs" in next).toBe(false);
});
