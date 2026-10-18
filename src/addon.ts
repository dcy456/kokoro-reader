import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { engine } from "./modules/engine";
import { player } from "./modules/player";
import { bar } from "./modules/bar";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    prefsPaneID?: string;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // Live instances, for debugging and tests.
  public api: { engine: typeof engine; player: typeof player; bar: typeof bar };

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = { engine, player, bar };
  }
}

export default Addon;
