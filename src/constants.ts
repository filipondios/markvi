// Valores compartidos entre el servidor y las rutas. La sesión SSE solo funciona
// mientras el timeout del servidor sea mayor que el heartbeat.

export const HOSTNAME = "127.0.0.1";
export const SSE_HEARTBEAT_MS = 25_000;
export const SERVER_IDLE_TIMEOUT_S = 60;
