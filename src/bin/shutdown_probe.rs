//! Test probe using the same shutdown path as the real server.
use markvi_server::watch::install_shutdown_signals;

#[tokio::main]
async fn main() {
    let signal = install_shutdown_signals();
    println!("ready");
    signal.await;
    println!("bye");
}
