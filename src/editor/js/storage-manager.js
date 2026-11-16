// Storage Manager - Handles IndexedDB & LocalStorage operations
import { downloadTextAsFile, showToast } from "./utils.js";

class ProjectStorageManager {
  constructor() {
    this.dbName = "SenangWebsTourDB";
    this.storeName = "projects";
    this.projectKey = "current_project";
    this.storageKey = "swt_project"; // For backward compatibility / migration
    this.autoSaveInterval = null;
    this.autoSaveDelay = 30000; // 30 seconds
    this.dbPromise = null;
  }

  /**
   * Open IndexedDB database with connection caching
   */
  _openDB() {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve) => {
      if (typeof window === "undefined" || !window.indexedDB) {
        resolve(null);
        return;
      }

      const request = window.indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "id" });
        }
      };

      request.onsuccess = (event) => {
        const db = event.target.result;
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = (event) => {
        console.warn("IndexedDB open error, falling back to localStorage:", event.target.error);
        resolve(null);
      };
    });

    return this.dbPromise;
  }

  /**
   * Save project to IndexedDB (with localStorage fallback)
   */
  async saveProject(projectData) {
    try {
      const now = new Date().toISOString();
      const db = await this._openDB();

      if (db) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction([this.storeName], "readwrite");
          const store = tx.objectStore(this.storeName);
          const record = {
            id: this.projectKey,
            data: projectData,
            lastSaved: now
          };
          const req = store.put(record);
          req.onsuccess = () => resolve();
          req.onerror = (e) => reject(e.target.error);
          tx.onerror = (e) => reject(e.target.error);
        });
        return true;
      }

      // Fallback to localStorage if IndexedDB is not available
      const json = JSON.stringify(projectData);
      localStorage.setItem(this.storageKey, json);
      localStorage.setItem(this.storageKey + "_lastSaved", now);
      return true;
    } catch (error) {
      console.error("Failed to save project:", error);
      if (error.name === "QuotaExceededError") {
        showToast("Storage quota exceeded. Project too large!", "error");
      } else {
        showToast("Failed to save project", "error");
      }
      return false;
    }
  }

  /**
   * Load project from IndexedDB (with localStorage migration/fallback)
   */
  async loadProject() {
    try {
      const db = await this._openDB();
      let projectData = null;

      if (db) {
        const record = await new Promise((resolve, reject) => {
          const tx = db.transaction([this.storeName], "readonly");
          const store = tx.objectStore(this.storeName);
          const req = store.get(this.projectKey);
          req.onsuccess = () => resolve(req.result);
          req.onerror = (e) => reject(e.target.error);
          tx.onerror = (e) => reject(e.target.error);
        });

        if (record && record.data) {
          projectData = record.data;
        }
      }

      // Check legacy localStorage if not found in IndexedDB
      if (!projectData && typeof localStorage !== "undefined") {
        const legacyJson = localStorage.getItem(this.storageKey);
        if (legacyJson) {
          try {
            projectData = JSON.parse(legacyJson);
            // Migrate legacy data into IndexedDB
            if (db && projectData) {
              await this.saveProject(projectData);
              localStorage.removeItem(this.storageKey);
              localStorage.removeItem(this.storageKey + "_lastSaved");
            }
          } catch (parseErr) {
            console.error("Failed to parse legacy localStorage project:", parseErr);
          }
        }
      }

      if (projectData) {
        if (!this.validateProjectData(projectData)) {
          console.error("Invalid project data structure");
          return null;
        }
        return projectData;
      }

      return null;
    } catch (error) {
      console.error("Failed to load project:", error);
      showToast("Failed to load project", "error");
      return null;
    }
  }

  /**
   * Validate project data structure
   */
  validateProjectData(projectData) {
    if (!projectData || typeof projectData !== "object") {
      return false;
    }

    // Check if scenes array exists and is valid
    if (!projectData.scenes || !Array.isArray(projectData.scenes)) {
      return false;
    }

    // Validate each scene has required properties
    for (const scene of projectData.scenes) {
      if (!scene || typeof scene !== "object") {
        return false;
      }

      // Required scene properties
      if (!scene.id || typeof scene.id !== "string") {
        return false;
      }

      // panorama or imageUrl is required for scenes to be valid (support both formats)
      const hasImage = (scene.panorama && typeof scene.panorama === "string") ||
                       (scene.imageUrl && typeof scene.imageUrl === "string");
      if (!hasImage) {
        return false;
      }

      // Hotspots array should exist (can be empty)
      if (!Array.isArray(scene.hotspots)) {
        scene.hotspots = []; // Auto-fix missing hotspots array
      }
    }

    // Ensure config exists
    if (!projectData.config || typeof projectData.config !== "object") {
      projectData.config = { title: "My Virtual Tour" };
    }

    return true;
  }

  /**
   * Clear project from storage
   */
  async clearProject() {
    try {
      const db = await this._openDB();
      if (db) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction([this.storeName], "readwrite");
          const store = tx.objectStore(this.storeName);
          const req = store.delete(this.projectKey);
          req.onsuccess = () => resolve();
          req.onerror = (e) => reject(e.target.error);
          tx.onerror = (e) => reject(e.target.error);
        });
      }
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(this.storageKey);
        localStorage.removeItem(this.storageKey + "_lastSaved");
      }
      return true;
    } catch (error) {
      console.error("Failed to clear project:", error);
      return false;
    }
  }

  /**
   * Check if project exists in storage
   */
  async hasProject() {
    try {
      const db = await this._openDB();
      if (db) {
        const count = await new Promise((resolve, reject) => {
          const tx = db.transaction([this.storeName], "readonly");
          const store = tx.objectStore(this.storeName);
          const req = store.count(this.projectKey);
          req.onsuccess = () => resolve(req.result);
          req.onerror = (e) => reject(e.target.error);
          tx.onerror = (e) => reject(e.target.error);
        });
        if (count > 0) return true;
      }
      if (typeof localStorage !== "undefined") {
        return localStorage.getItem(this.storageKey) !== null;
      }
      return false;
    } catch (error) {
      console.error("Failed to check project exists:", error);
      return false;
    }
  }

  /**
   * Get last saved date
   */
  async getLastSavedDate() {
    try {
      const db = await this._openDB();
      if (db) {
        const record = await new Promise((resolve, reject) => {
          const tx = db.transaction([this.storeName], "readonly");
          const store = tx.objectStore(this.storeName);
          const req = store.get(this.projectKey);
          req.onsuccess = () => resolve(req.result);
          req.onerror = (e) => reject(e.target.error);
        });
        if (record && record.lastSaved) {
          return new Date(record.lastSaved);
        }
      }
      if (typeof localStorage !== "undefined") {
        const dateStr = localStorage.getItem(this.storageKey + "_lastSaved");
        return dateStr ? new Date(dateStr) : null;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Start auto-save
   */
  startAutoSave(callback, delay = null) {
    this.stopAutoSave();
    const intervalDelay = delay !== null ? delay : this.autoSaveDelay;
    this.autoSaveInterval = setInterval(() => {
      callback();
    }, intervalDelay);
  }

  /**
   * Stop auto-save
   */
  stopAutoSave() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
  }

  /**
   * Export project to file
   */
  exportToFile(projectData, filename = "tour.json") {
    try {
      const json = JSON.stringify(projectData, null, 2);
      downloadTextAsFile(json, filename);
      return true;
    } catch (error) {
      console.error("Failed to export project:", error);
      showToast("Failed to export project", "error");
      return false;
    }
  }

  /**
   * Extract tour configuration from exported viewer HTML
   * @param {string} html - HTML file content
   * @returns {Object} Parsed tour configuration object
   */
  extractTourConfigFromHtml(html) {
    const tourConfigIdx = html.indexOf("tourConfig");
    if (tourConfigIdx === -1) {
      throw new Error("No virtual tour configuration found in HTML file");
    }

    const eqIdx = html.indexOf("=", tourConfigIdx);
    if (eqIdx === -1) {
      throw new Error("Invalid tour configuration assignment in HTML");
    }

    const startBrace = html.indexOf("{", eqIdx);
    if (startBrace === -1) {
      throw new Error("No object start '{' found for tour configuration");
    }

    // Parse balanced curly braces, respecting string literals and escapes
    let depth = 0;
    let inString = false;
    let escape = false;
    let endBrace = -1;

    for (let i = startBrace; i < html.length; i++) {
      const ch = html[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            endBrace = i;
            break;
          }
        }
      }
    }

    if (endBrace === -1) {
      throw new Error("Mismatched braces while parsing tourConfig in HTML");
    }

    const jsonString = html.substring(startBrace, endBrace + 1);
    try {
      return JSON.parse(jsonString);
    } catch (parseError) {
      console.error("JSON.parse failed on extracted tourConfig:", parseError);
      throw new Error("Corrupted tour configuration inside HTML: " + parseError.message);
    }
  }

  /**
   * Import project from file (supports both .json and exported viewer .html)
   */
  async importFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (e) => {
        try {
          const content = e.target.result;
          let projectData;

          const fileNameLower = (file.name || '').toLowerCase();
          const trimmedLower = content.trim().toLowerCase();
          const isHtml = fileNameLower.endsWith('.html') || 
                         fileNameLower.endsWith('.htm') || 
                         trimmedLower.startsWith('<!doctype') || 
                         trimmedLower.startsWith('<html') ||
                         content.includes('tourConfig');

          try {
            if (isHtml) {
              projectData = this.extractTourConfigFromHtml(content);
            } else {
              projectData = JSON.parse(content);
            }
          } catch (primaryError) {
            // Dual fallback: if HTML extraction failed, try JSON.parse; if JSON.parse failed, try HTML extraction
            try {
              if (isHtml) {
                projectData = JSON.parse(content);
              } else {
                projectData = this.extractTourConfigFromHtml(content);
              }
            } catch (fallbackError) {
              throw primaryError;
            }
          }

          resolve(projectData);
        } catch (error) {
          console.error("Failed to parse project file:", error);
          const errorMsg = error.message && error.message.includes("tour configuration")
            ? error.message
            : "Invalid or corrupt project file";
          showToast(errorMsg, "error");
          reject(error);
        }
      };

      reader.onerror = () => {
        console.error("Failed to read file:", reader.error);
        showToast("Failed to read file", "error");
        reject(reader.error);
      };

      reader.readAsText(file);
    });
  }
}

export default ProjectStorageManager;
