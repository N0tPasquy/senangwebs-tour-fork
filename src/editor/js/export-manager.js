// Export Manager - Handles JSON generation for SWT library
import { downloadTextAsFile, showModal, copyToClipboard, showToast, sanitizeId, deepClone, escapeHtml, safeJsonStringify } from "./utils.js";
import { IconRenderer } from "../../IconRenderer.js";
import { buildTourConfig } from "./data-transform.js";
import { EditorEvents } from "./event-emitter.js";
import packageInfo from "../../../package.json";

class ExportManager {
  constructor(editor) {
    this.editor = editor;
    this.iconRenderer = new IconRenderer();
  }

  /**
   * Generate JSON compatible with SWT library
   * Follows the tourConfig structure from example-simple.html
   * Uses shared data-transform utilities for consistent transformation
   */
  generateJSON() {
    const scenes = this.editor.sceneManager.getAllScenes();
    const config = this.editor.config;

    return buildTourConfig(config, scenes);
  }

  /**
   * Load tour data from JSON (inverse of generateJSON)
   * This loads the entire tour configuration including initialScene and all scenes
   * @param {Object} tourData - Tour configuration object with initialScene and scenes
   * @param {string} tourData.initialScene - Initial scene ID
   * @param {Array} tourData.scenes - Array of scene objects
   * @returns {boolean} Success status
   */
  loadJSON(tourData) {
    try {
      if (!tourData || typeof tourData !== 'object') {
        console.error('Invalid tour data: expected object');
        return false;
      }

      // Load scenes into scene manager
      const scenes = tourData.scenes || [];
      this.editor.sceneManager.loadScenes(scenes);

      // Set initial scene in config (accepts both initialSceneId and initialScene)
      const requestedInitialScene =
        (tourData.config && tourData.config.initialSceneId) ||
        tourData.initialSceneId ||
        tourData.initialScene;
      if (requestedInitialScene && this.editor.sceneManager.getSceneById(requestedInitialScene)) {
        this.editor.config.initialSceneId = requestedInitialScene;
      } else if (scenes.length > 0) {
        this.editor.config.initialSceneId = scenes[0].id;
      }

      if (tourData.title) {
        this.editor.config.title = tourData.title;
      }
      if (tourData.description) {
        this.editor.config.description = tourData.description;
      }
      if (tourData.audio && tourData.audio.url) {
        this.editor.config.audio = {
          url: tourData.audio.url,
          volume: typeof tourData.audio.volume === 'number' ? tourData.audio.volume : 0.5,
          loop: tourData.audio.loop !== false
        };
      } else {
        delete this.editor.config.audio;
      }
      if (tourData.welcome && tourData.welcome.enabled !== false && (tourData.welcome.enabled || tourData.welcome.title || tourData.welcome.description)) {
        this.editor.config.welcome = {
          enabled: tourData.welcome.enabled !== false,
          title: tourData.welcome.title || '',
          description: tourData.welcome.description || '',
          buttonText: tourData.welcome.buttonText || 'Start Tour'
        };
      } else {
        delete this.editor.config.welcome;
      }

      // Reset preview and selection state so the new project renders cleanly
      this.editor.hotspotEditor.currentHotspotIndex = -1;
      this.editor.lastRenderedSceneIndex = -1;

      // Mark as having unsaved changes
      this.editor.hasUnsavedChanges = true;

      // Re-render the editor UI
      this.editor.render();

      showToast('Tour loaded successfully', 'success');
      
      // Emit event
      this.editor.emit(EditorEvents.PROJECT_LOAD, { tourData, source: 'loadJSON' });
      
      return true;
    } catch (error) {
      console.error('Failed to load tour data:', error);
      showToast('Failed to load tour', 'error');
      return false;
    }
  }

  /**
   * Generate JSON with icons baked in as SVG data URLs
   * This ensures the exported HTML doesn't need the SenangStart icons library
   */
  async generateJSONWithBakedIcons() {
    const raw = this.generateJSON();
    // Shallow-clone scenes and hotspots to avoid duplicating massive base64 image strings
    const jsonData = {
      ...raw,
      scenes: (raw.scenes || []).map((scene) => ({
        ...scene,
        hotspots: (scene.hotspots || []).map((h) => ({
          ...h,
          appearance: { ...(h.appearance || {}) },
        })),
      })),
    };

    // Process icons SEQUENTIALLY: IconRenderer uses a single shared render
    // container, so parallel generation would corrupt captured icons.
    for (const scene of jsonData.scenes) {
      for (const hotspot of scene.hotspots) {
        const icon = hotspot.appearance?.icon;

        // Skip if no icon or if it's already a data URL or URL
        if (!icon) continue;
        if (icon.startsWith('data:') || icon.startsWith('http') || icon.startsWith('/')) continue;

        // Generate SVG data URL from icon name
        try {
          const color = hotspot.appearance?.color || '#ffffff';
          const dataUrl = await this.iconRenderer.generateIconDataUrl(icon, color, 128);
          if (dataUrl) {
            hotspot.appearance.icon = dataUrl;
          }
        } catch (err) {
          console.warn(`Failed to bake icon "${icon}" for export:`, err);
        }
      }
    }

    return jsonData;
  }

  /**
   * Export as JSON file
   */
  exportJSON() {
    try {
      const jsonData = this.generateJSON();
      let json;
      try {
        json = JSON.stringify(jsonData, null, 2);
      } catch (formatErr) {
        // Fallback to compact unindented JSON if memory limits are exceeded
        json = JSON.stringify(jsonData);
      }

      const title = this.editor.config.title || "tour";
      const filename = sanitizeId(title) + ".json";
      downloadTextAsFile(json, filename);

      showToast("Tour exported successfully", "success");
      return true;
    } catch (error) {
      console.error("Export failed:", error);
      showToast("Export failed", "error");
      return false;
    }
  }

  /**
   * Copy JSON to clipboard
   */
  async copyJSON() {
    try {
      const jsonData = this.generateJSON();
      let json;
      try {
        json = JSON.stringify(jsonData, null, 2);
      } catch (formatErr) {
        json = JSON.stringify(jsonData);
      }

      // Check size: clipboard APIs fail on huge payloads (> 5MB)
      if (json.length > 5 * 1024 * 1024) {
        showToast(
          `Project is too large for clipboard (${(json.length / 1048576).toFixed(1)} MB). Please use "Download JSON".`,
          "warning",
          5000
        );
        return false;
      }

      const success = await copyToClipboard(json);
      if (success) {
        showToast("JSON copied to clipboard", "success");
      } else {
        showToast("Failed to copy to clipboard", "error");
      }
      return success;
    } catch (error) {
      console.error("Copy failed:", error);
      showToast("Copy failed", "error");
      return false;
    }
  }

  /**
   * Generate HTML viewer code with icons baked in
   */
  async generateViewerHTML() {
    const jsonData = await this.generateJSONWithBakedIcons();
    const rawTitle = this.editor.config.title || "Virtual Tour";
    // Escape for the HTML <title> context
    const title = escapeHtml(rawTitle);
    // Pin the runtime version so exported viewers are reproducible
    const runtimeVersion = packageInfo.version;
    const serializedConfig = safeJsonStringify(jsonData);

    // If exported from a web server (e.g. Altervista), add origin server fallback
    const hostBase = (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null' && !window.location.protocol.startsWith('file'))
      ? window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '') + '/swt.min.js'
      : '';
    const originFallback = hostBase ? `
    <script>
      if (typeof SWT === "undefined") {
        document.write('<script src="${hostBase}"><\\/script>');
      }
    </script>` : '';

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <!-- SWT Library: 1. same folder (fast/offline) -> 2. local dev -> 3. server host -> 4. jsDelivr GitHub CDN -->
    <script src="swt.min.js?v=${runtimeVersion}"></script>
    <script>
      if (typeof SWT === "undefined") {
        document.write('<script src="../dist/swt.min.js"><\\/script>');
      }
    </script>${originFallback}
    <script>
      if (typeof SWT === "undefined") {
        document.write(
          '<script src="https://cdn.jsdelivr.net/gh/N0tPasquy/senangwebs-tour-fork@master/dist/swt.min.js"><\\/script>'
        );
      }
    </script>
  </head>
  <body>
    <a-scene id="tour-container" loading-screen="enabled: false">
      <a-camera look-controls>
        <a-cursor fuse="false" cursor="fuse: false; fuseTimeout: 0;" raycaster="objects: .clickable;"></a-cursor>
      </a-camera>
    </a-scene>

    <script>
      // Tour configuration
      // Serialized with <, >, & escaped so the data cannot break out of this script
      const tourConfig = ${serializedConfig};

      // Initialize tour when scene is loaded (handling both already-loaded and pending load)
      const sceneEl = document.querySelector("#tour-container");
      function startTour() {
        if (typeof SWT === "undefined" || !SWT.Tour) {
          setTimeout(startTour, 30);
          return;
        }
        const tour = new SWT.Tour(sceneEl, tourConfig);
        tour.start();
      }

      if (sceneEl.hasLoaded) {
        startTour();
      } else {
        sceneEl.addEventListener("loaded", startTour);
      }
    </script>
  </body>
</html>`;
  }

  /**
   * Export as standalone HTML viewer with icons baked in
   */
  async exportViewerHTML() {
    try {
      const html = await this.generateViewerHTML();
      const title = this.editor.config.title || "tour";
      const filename = sanitizeId(title) + "-viewer.html";

      downloadTextAsFile(html, filename);

      showToast("Viewer HTML exported successfully", "success");
      return true;
    } catch (error) {
      console.error("Export viewer failed:", error);
      showToast("Export viewer failed", "error");
      return false;
    }
  }

  /**
   * Show export modal
   */
  showExportPreview() {
    showModal("exportModal");
    return true;
  }
}

export default ExportManager;
