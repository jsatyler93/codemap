import Plotly from "plotly.js-dist-min";

export function createPlotlyViewer({ rootEl, onClose }) {
  if (!rootEl) {
    return {
      show() {},
      hide() {},
    };
  }

  const host = document.createElement("div");
  host.className = "cm-plotly-viewer";
  host.innerHTML = `
    <div class="cm-plotly-backdrop" data-close="true"></div>
    <section class="cm-plotly-dialog" role="dialog" aria-modal="true" aria-label="Probe Plot Viewer">
      <header class="cm-plotly-header">
        <div class="cm-plotly-title"></div>
        <button class="cm-plotly-close" type="button" data-close="true">close</button>
      </header>
      <div class="cm-plotly-meta"></div>
      <div class="cm-plotly-canvas"></div>
    </section>
  `;
  rootEl.appendChild(host);

  const titleEl = host.querySelector(".cm-plotly-title");
  const metaEl = host.querySelector(".cm-plotly-meta");
  const plotEl = host.querySelector(".cm-plotly-canvas");

  for (const closeEl of host.querySelectorAll("[data-close='true']")) {
    closeEl.addEventListener("click", () => {
      hide();
      onClose?.();
    });
  }

  function hide() {
    host.classList.remove("is-open");
    try {
      Plotly.purge(plotEl);
    } catch {
      // Ignore purge errors when plot not initialized.
    }
  }

  async function show({ probe, result }) {
    if (!probe || !result || result.error) return;
    const chart = buildPlotlyChart(probe.widgetSpec || { type: "plotly", chartType: "auto" }, result.data);
    titleEl.textContent = probe.widgetSpec?.title || probe.label || "Probe Plot";
    metaEl.textContent = `${probe.nodeId} · hit ${result.hitCount || 0}`;
    host.classList.add("is-open");
    await Plotly.newPlot(plotEl, chart.data, chart.layout, {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["select2d", "lasso2d", "resetScale2d"],
      scrollZoom: true,
    });
  }

  return { show, hide };
}

function buildPlotlyChart(widgetSpec, payload) {
  const chartType = widgetSpec?.type === "plotly" ? widgetSpec.chartType || "auto" : "auto";
  const chart = chartType === "auto" ? inferChart(widgetSpec, payload) : byChartType(chartType, widgetSpec, payload);
  return chart || fallbackChart(widgetSpec, payload);
}

function inferChart(widgetSpec, payload) {
  if (Array.isArray(payload) && payload.length && Array.isArray(payload[0])) {
    return heatmapChart(widgetSpec, payload);
  }
  if (isObject(payload) && Array.isArray(payload.z) && Array.isArray(payload.z[0])) {
    return heatmapChart(widgetSpec, payload.z, payload.x, payload.y);
  }
  if (isObject(payload) && Array.isArray(payload.x) && Array.isArray(payload.y)) {
    return lineChart(widgetSpec, payload.x, payload.y);
  }
  const series = numericSeries(payload);
  if (series.length >= 3) {
    return histogramChart(widgetSpec, series);
  }
  if (isObject(payload)) {
    const scalarEntries = Object.entries(payload).filter(([, value]) => Number.isFinite(Number(value)));
    if (scalarEntries.length) {
      return barChart(widgetSpec, scalarEntries);
    }
  }
  return null;
}

function byChartType(type, widgetSpec, payload) {
  if (type === "line") {
    const x = isObject(payload) && Array.isArray(payload.x) ? payload.x : undefined;
    const y = isObject(payload) && Array.isArray(payload.y) ? payload.y : numericSeries(payload);
    return lineChart(widgetSpec, x || y.map((_, index) => index), y);
  }
  if (type === "scatter") {
    const x = isObject(payload) && Array.isArray(payload.x) ? payload.x : [];
    const y = isObject(payload) && Array.isArray(payload.y) ? payload.y : numericSeries(payload);
    return scatterChart(widgetSpec, x.length ? x : y.map((_, index) => index), y);
  }
  if (type === "bar") {
    const entries = isObject(payload)
      ? Object.entries(payload).filter(([, value]) => Number.isFinite(Number(value)))
      : [];
    return barChart(widgetSpec, entries);
  }
  if (type === "histogram") {
    return histogramChart(widgetSpec, numericSeries(payload));
  }
  if (type === "box") {
    return boxChart(widgetSpec, numericSeries(payload));
  }
  if (type === "heatmap") {
    const z = isObject(payload) && Array.isArray(payload.z) ? payload.z : payload;
    const x = isObject(payload) ? payload.x : undefined;
    const y = isObject(payload) ? payload.y : undefined;
    return heatmapChart(widgetSpec, z, x, y);
  }
  if (type === "surface3d") {
    const z = isObject(payload) && Array.isArray(payload.z) ? payload.z : payload;
    return surface3dChart(widgetSpec, z);
  }
  return null;
}

function lineChart(widgetSpec, x, y) {
  if (!Array.isArray(x) || !Array.isArray(y) || !y.length) return null;
  return {
    data: [{ type: "scatter", mode: "lines", x, y, line: { color: "#7aa2f7", width: 2 } }],
    layout: baseLayout(widgetSpec, "line"),
  };
}

function scatterChart(widgetSpec, x, y) {
  if (!Array.isArray(x) || !Array.isArray(y) || !y.length) return null;
  return {
    data: [{ type: "scatter", mode: "markers", x, y, marker: { color: "#73daca", size: 6 } }],
    layout: baseLayout(widgetSpec, "scatter"),
  };
}

function barChart(widgetSpec, entries) {
  if (!entries.length) return null;
  return {
    data: [{ type: "bar", x: entries.map(([label]) => label), y: entries.map(([, value]) => Number(value)), marker: { color: "#bb9af7" } }],
    layout: baseLayout(widgetSpec, "bar"),
  };
}

function histogramChart(widgetSpec, values) {
  if (!values.length) return null;
  return {
    data: [{ type: "histogram", x: values, marker: { color: "#e0af68" } }],
    layout: baseLayout(widgetSpec, "histogram"),
  };
}

function boxChart(widgetSpec, values) {
  if (!values.length) return null;
  return {
    data: [{ type: "box", y: values, marker: { color: "#9ece6a" }, boxpoints: "outliers" }],
    layout: baseLayout(widgetSpec, "box"),
  };
}

function heatmapChart(widgetSpec, z, x, y) {
  if (!Array.isArray(z) || !z.length || !Array.isArray(z[0])) return null;
  return {
    data: [{ type: "heatmap", z, x, y, colorscale: "RdBu", reversescale: true }],
    layout: baseLayout(widgetSpec, "heatmap"),
  };
}

function surface3dChart(widgetSpec, z) {
  if (!Array.isArray(z) || !z.length || !Array.isArray(z[0])) return null;
  return {
    data: [{ type: "surface", z, colorscale: "Viridis" }],
    layout: {
      ...baseLayout(widgetSpec, "surface3d"),
      scene: {
        xaxis: { title: widgetSpec?.xLabel || "x" },
        yaxis: { title: widgetSpec?.yLabel || "y" },
        zaxis: { title: widgetSpec?.zLabel || "z" },
      },
    },
  };
}

function fallbackChart(widgetSpec, payload) {
  const text = JSON.stringify(payload, null, 2);
  return {
    data: [{ type: "table", header: { values: ["payload"] }, cells: { values: [[text || "(empty)"]] } }],
    layout: baseLayout(widgetSpec, "table"),
  };
}

function baseLayout(widgetSpec, kind) {
  return {
    title: { text: widgetSpec?.title || kind, font: { color: "#dfe6ff", size: 14 } },
    paper_bgcolor: "#0d1220",
    plot_bgcolor: "#0d1220",
    font: { color: "#dfe6ff", family: "Consolas, monospace", size: 11 },
    margin: { l: 56, r: 24, t: 44, b: 44 },
    xaxis: { title: widgetSpec?.xLabel || "", gridcolor: "rgba(143,155,184,0.16)", zerolinecolor: "rgba(143,155,184,0.18)" },
    yaxis: { title: widgetSpec?.yLabel || "", gridcolor: "rgba(143,155,184,0.16)", zerolinecolor: "rgba(143,155,184,0.18)" },
  };
}

function numericSeries(payload) {
  if (Array.isArray(payload)) {
    return payload.map(Number).filter(Number.isFinite);
  }
  if (isObject(payload)) {
    for (const value of Object.values(payload)) {
      if (Array.isArray(value)) {
        const arr = value.map(Number).filter(Number.isFinite);
        if (arr.length) return arr;
      }
    }
  }
  return [];
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
