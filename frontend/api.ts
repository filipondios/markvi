// Cliente HTTP de la API. La primera lectura de config/archivo/árbol ya salió
// del HTML; `takeEarly` la recoge por URL exacta.

import { takeEarly } from "./config.ts";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api(url: string, init?: RequestInit): Promise<Response> {
  const response = await ((!init && takeEarly(url)) || fetch(url, init));
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, body?.error ?? `Error ${response.status}`);
  }
  return response;
}
