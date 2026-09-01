/**
 * The dsh browser half: a `dsh.client` module that renders a launched Agent App
 * in an iframe inside its own panel slot. A shipped client bundle is plain built
 * JS (not a model-authored dynamic module), so it may use the DOM and iframe
 * freely.
 */
export interface DshClientHost {
  slot: HTMLElement;
}

/** Render the app at `url` into the provided slot. */
export function renderAgentApp(host: DshClientHost, app: { name: string; url: string }): void {
  const frame = document.createElement("iframe");
  frame.src = app.url;
  frame.title = app.name;
  frame.style.width = "100%";
  frame.style.height = "100%";
  frame.style.border = "0";
  host.slot.replaceChildren(frame);
}
