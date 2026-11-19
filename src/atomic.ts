// Escritura de archivos sin riesgo de perder el contenido anterior, y bloqueo por
// archivo para las peticiones concurrentes.
//
// Escribir directamente sobre el archivo lo trunca antes de copiar el contenido
// nuevo. Si el disco se llena (ENOSPC), el proceso muere o se va la luz a mitad,
// la nota queda vacía o a medias aunque el servidor conteste «no se pudo guardar».
// Aquí se escribe un archivo temporal al lado, se sincroniza y se renombra encima:
// `rename` es atómico, así que el archivo es siempre el contenido viejo entero o
// el nuevo entero.

import { randomBytes } from "node:crypto";
import { chmod, link, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Oculto (empieza por `.`): ni el listado ni el watcher ni la API lo ven. Nombre
// corto y fijo para no pasar del máximo de longitud con nombres de archivo largos.
const tempPathFor = (target: string) =>
  join(dirname(target), `.markvi-${randomBytes(6).toString("hex")}.tmp`);

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Escribe y sincroniza `data` en un archivo temporal nuevo; devuelve su ruta. */
async function writeTemp(target: string, data: string, mode: number | undefined) {
  const temp = tempPathFor(target);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, "wx", mode ?? 0o666);
    await handle.writeFile(data, "utf8");
    // Sin esto, tras un corte de luz el rename podría sobrevivir y los datos no.
    await handle.sync();
    await handle.close();
    handle = undefined;
    // `open` aplica la umask: se restaura el permiso exacto del archivo original.
    if (mode !== undefined) await chmod(temp, mode);
    return temp;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** Mejor esfuerzo: que el rename sobreviva a un corte. No existe en todos los sistemas. */
async function syncDirectory(directory: string) {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows y algunos sistemas de archivos no permiten sincronizar carpetas.
  }
}

/**
 * Sustituye el contenido de `target` (o lo crea) de forma atómica. Conserva los
 * permisos del archivo existente. `target` debe ser la ruta real: si fuera un
 * enlace simbólico, el rename lo reemplazaría en lugar de escribir su destino.
 *
 * Si la carpeta no admite crear archivos pero el archivo sí es escribible (carpetas
 * compartidas de solo lectura, por ejemplo), se escribe en el sitio como antes: es
 * mejor guardar sin garantía de atomicidad que no poder guardar.
 */
export async function writeFileAtomic(target: string, data: string): Promise<void> {
  const mode = await stat(target).then(
    (info) => info.mode & 0o7777,
    () => undefined,
  );

  let temp: string;
  try {
    temp = await writeTemp(target, data, mode);
  } catch (error) {
    if (mode !== undefined && (codeOf(error) === "EACCES" || codeOf(error) === "EPERM")) {
      await writeFile(target, data);
      return;
    }
    throw error;
  }

  try {
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  await syncDirectory(dirname(target));
}

/**
 * Crea `target` con `data` sin sobrescribir nada: falla con `EEXIST` si existe. El
 * contenido se escribe antes en un temporal y se enlaza con su nombre definitivo,
 * así nadie lee un archivo nuevo a medio escribir ni queda uno vacío si falla.
 */
export async function createFileExclusive(target: string, data: string): Promise<void> {
  const temp = await writeTemp(target, data, undefined);
  try {
    await link(temp, target);
  } catch (error) {
    // Sistemas sin enlaces duros (FAT, algunos montajes de red): creación directa.
    if (["EPERM", "ENOTSUP", "ENOSYS", "EXDEV", "EOPNOTSUPP"].includes(codeOf(error) ?? "")) {
      try {
        await writeFile(target, data, { flag: "wx" });
      } catch (fallbackError) {
        await unlink(temp).catch(() => {});
        throw fallbackError;
      }
    } else {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  await unlink(temp).catch(() => {});
  await syncDirectory(dirname(target));
}

const tails = new Map<string, Promise<unknown>>();

/**
 * Ejecuta `task` en cola con las demás tareas de la misma clave (la ruta real del
 * archivo). Sin esto, dos peticiones simultáneas con el mismo `If-Match` leen ambas
 * el archivo antes de que la otra escriba y las dos «ganan»: se pierde una edición.
 */
export function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
