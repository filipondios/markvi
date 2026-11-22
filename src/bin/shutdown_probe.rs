//! Sonda de tests: usa la misma función de apagado que el servidor real.
use markvi_server::watch::install_shutdown_signals;

#[tokio::main]
async fn main() {
    let signal = install_shutdown_signals();
    println!("ready");
    signal.await;
    println!("bye");
}
