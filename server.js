const App = require("./src/app");

function startApp() {
  const app = new App();
  app.start();
  return app;
}

startApp();
