// Al pulsar el icono de la extensión se abre el panel lateral.
function configurarPanel() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error("No se pudo configurar el panel lateral:", e));
}

chrome.runtime.onInstalled.addListener(configurarPanel);
chrome.runtime.onStartup.addListener(configurarPanel);
configurarPanel();
