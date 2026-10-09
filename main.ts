import { App, staticFiles } from "fresh";
import { zooRoutes } from "./lib/zoo_app.ts";

export const app = new App();

app.use(staticFiles());
zooRoutes(app);
app.fsRoutes();
