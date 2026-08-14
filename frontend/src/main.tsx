import Editor from "@toast-ui/editor";
import "@toast-ui/editor/dist/toastui-editor.css";
import "@toast-ui/editor/dist/theme/toastui-editor-dark.css";
import { NotesService, type Note } from "../bindings/changeme";

let notes: Note[] = [];
let currentNote: Note | null = null;
let notesFolder = "";
let updateTimeout: ReturnType<typeof setTimeout> | undefined;
let editor: Editor | null = null;
let suppressChange = false;

function getEl<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// Markdown WYSIWYG editor
function initEditor() {
  const el = getEl<HTMLDivElement>("note-content");
  if (!el) return;

  editor = new Editor({
    el,
    height: "100%",
    initialEditType: "wysiwyg",
    hideModeSwitch: false,
    theme: "dark",
    usageStatistics: false,
    placeholder: "Start typing...",
    toolbarItems: [
      ["heading", "bold", "italic", "strike"],
      ["hr", "quote"],
      ["ul", "ol", "task", "indent", "outdent"],
      ["table", "link"],
      ["code", "codeblock"],
    ],
    events: {
      change: () => {
        if (suppressChange) return;
        setSaveStatus("Saving\u2026");
        scheduleUpdate();
      },
    },
  });
}

function setSaveStatus(text: string) {
  const el = getEl<HTMLElement>("save-status");
  if (el) el.textContent = text;
}

// Load folder + notes on startup
async function init() {
  initEditor();
  notesFolder = (await NotesService.GetFolder()) ?? "";
  updateFolderUI();
  notes = (await NotesService.GetAll()) ?? [];
  renderNotesList();
}

function updateFolderUI() {
  const folderPath = getEl<HTMLDivElement>("folder-path");
  if (folderPath) {
    folderPath.textContent = notesFolder || "No folder selected";
    folderPath.title = notesFolder;
  }
  const emptyState = getEl<HTMLDivElement>("empty-state");
  if (emptyState && !notesFolder) {
    emptyState.innerHTML =
      "<h2>No notes folder</h2><p>Click Folder to choose where your markdown notes live</p>";
  }
}

// Render notes list
function renderNotesList() {
  const notesList = getEl<HTMLDivElement>("notes-list");
  if (!notesList) return;

  if (notes.length === 0) {
    notesList.innerHTML =
      '<div style="padding: 20px; text-align: center; color: #6272a4;">No notes yet</div>';
    return;
  }

  notesList.innerHTML = notes
    .map(
      (note) => `
        <div class="note-item ${
          currentNote?.id === note.id ? "active" : ""
        }" data-id="${note.id}">
          <h3>${escapeHtml(note.title) || "Untitled"}</h3>
          <p>${escapeHtml(note.content) || "No content"}</p>
        </div>
      `,
    )
    .join("");

  document.querySelectorAll(".note-item").forEach((item) => {
    const el = item as HTMLElement;

    el.addEventListener("click", () => {
      const id = el.dataset.id;
      if (id) {
        selectNote(id);
      }
    });
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Select a note
function selectNote(id: string) {
  currentNote = notes.find((n) => n.id === id) ?? null;

  if (!currentNote) return;

  const emptyState = getEl<HTMLDivElement>("empty-state");
  const noteEditor = getEl<HTMLDivElement>("note-editor");
  const noteTitle = getEl<HTMLInputElement>("note-title");
  const lastUpdated = getEl<HTMLElement>("last-updated");

  if (emptyState) emptyState.style.display = "none";
  if (noteEditor) noteEditor.style.display = "flex";
  if (noteTitle) noteTitle.value = currentNote.title;
  if (editor) {
    suppressChange = true;
    editor.setMarkdown(currentNote.content, false);
    suppressChange = false;
  }
  if (lastUpdated) {
    lastUpdated.textContent = `Last updated: ${new Date(
      currentNote.updatedAt,
    ).toLocaleString()}`;
  }
  setSaveStatus("");

  renderNotesList();
}

// Choose notes folder
async function chooseFolder(): Promise<boolean> {
  try {
    const folder = await NotesService.SelectFolder();
    if (!folder) return false;
    notesFolder = folder;
    updateFolderUI();
    notes = (await NotesService.GetAll()) ?? [];
    currentNote = null;
    renderNotesList();
    return true;
  } catch (error) {
    console.error("Folder selection failed:", error);
    return false;
  }
}

getEl<HTMLButtonElement>("folder-btn")?.addEventListener("click", chooseFolder);

// Create new note
getEl<HTMLButtonElement>("new-note-btn")?.addEventListener(
  "click",
  async () => {
    if (!notesFolder) {
      const ok = await chooseFolder();
      if (!ok) return;
    }
    try {
      const note = await NotesService.Create("Untitled", "");
      notes.push(note);
      selectNote(note.id);

      const titleInput = getEl<HTMLInputElement>("note-title");
      titleInput?.focus();
      titleInput?.select();
    } catch (error) {
      console.error("Create failed:", error);
    }
  },
);

// Sidebar collapse
getEl<HTMLButtonElement>("sidebar-toggle")?.addEventListener("click", () => {
  getEl<HTMLDivElement>("sidebar")?.classList.toggle("collapsed");
});

// Update note on input (debounced autosave to disk)
function scheduleUpdate() {
  clearTimeout(updateTimeout);
  updateTimeout = setTimeout(saveNow, 500);
}

// Immediate save of current note
async function saveNow() {
  clearTimeout(updateTimeout);
  if (!currentNote) return;

  const titleEl = getEl<HTMLInputElement>("note-title");
  const title = titleEl?.value ?? "";
  const content = editor?.getMarkdown() ?? "";

  try {
    await NotesService.Update(currentNote.id, title, content);
    setSaveStatus("Saved");
  } catch (error) {
    setSaveStatus("Save failed!");
    console.error("Save failed:", error);
    return;
  }

  const note = notes.find((n) => n.id === currentNote?.id);
  if (note) {
    note.title = title;
    note.content = content;
    note.updatedAt = new Date().toISOString();
  }

  renderNotesList();

  const lastUpdated = getEl<HTMLElement>("last-updated");
  if (lastUpdated) {
    lastUpdated.textContent = `Last updated: ${new Date().toLocaleString()}`;
  }
}

// Manual save button + Ctrl+S
getEl<HTMLButtonElement>("save-btn")?.addEventListener("click", saveNow);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    saveNow();
  }
});

// Manual reload from disk (picks up external edits)
getEl<HTMLButtonElement>("reload-btn")?.addEventListener("click", async () => {
  if (!notesFolder) {
    await chooseFolder();
    return;
  }
  try {
    await NotesService.Reload();
    notes = (await NotesService.GetAll()) ?? [];
    const previousId = currentNote?.id;
    currentNote = null;

    if (previousId && notes.some((n) => n.id === previousId)) {
      selectNote(previousId);
    } else {
      const emptyState = getEl<HTMLDivElement>("empty-state");
      const noteEditor = getEl<HTMLDivElement>("note-editor");
      if (emptyState) emptyState.style.display = "flex";
      if (noteEditor) noteEditor.style.display = "none";
      renderNotesList();
    }
  } catch (error) {
    console.error("Reload failed:", error);
  }
});

getEl<HTMLInputElement>("note-title")?.addEventListener("input", () => {
  setSaveStatus("Saving\u2026");
  scheduleUpdate();
});

// Delete note
getEl<HTMLButtonElement>("delete-btn")?.addEventListener("click", async () => {
  if (!currentNote) return;

  try {
    await NotesService.Delete(currentNote.id);
    notes = notes.filter((n) => n.id !== currentNote?.id);
    currentNote = null;

    const emptyState = getEl<HTMLDivElement>("empty-state");
    const noteEditor = getEl<HTMLDivElement>("note-editor");

    if (emptyState) emptyState.style.display = "flex";
    if (noteEditor) noteEditor.style.display = "none";

    renderNotesList();
  } catch (error) {
    console.error("Delete failed:", error);
  }
});

// Initialize
init();
