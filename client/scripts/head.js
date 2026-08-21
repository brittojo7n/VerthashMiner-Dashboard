(function () {
  try {
    var h = parseInt(window.localStorage.getItem("vmd:gpuH"), 10);
    if (isFinite(h) && h >= 200 && h <= 4000) {
      document.documentElement.style.setProperty("--gpus-min", h + "px");
    }
  } catch (e) {
  }
})();
