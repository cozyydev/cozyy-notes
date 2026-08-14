package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type Note struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type NotesService struct {
	dir   string
	notes []Note
}

func NewNotesService() *NotesService {
	s := &NotesService{
		notes: make([]Note, 0),
		files: make(map[string]string),
	}
	if dir := loadConfig(); dir != "" {
		if err := s.loadFolder(dir); err == nil {
			s.dir = dir
		}
	}
	return s
}

// GetFolder returns the current notes folder ("" if none selected)
func (n *NotesService) GetFolder() string {
	return n.dir
}

// SelectFolder prompts for a notes folder and loads all markdown files in it
func (n *NotesService) SelectFolder() (string, error) {
	path, err := application.Get().Dialog.OpenFile().
		CanChooseDirectories(true).
		CanChooseFiles(false).
		SetTitle("Choose Notes Folder").
		PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	if path == "" {
		// User cancelled the dialog
		return n.dir, nil
	}
	if err := n.loadFolder(path); err != nil {
		return "", err
	}
	n.dir = path
	saveConfig(path)
	return path, nil
}

// GetAll returns all notes, most recently updated first
func (n *NotesService) GetAll() []Note {
	sort.Slice(n.notes, func(i, j int) bool {
		return n.notes[i].UpdatedAt.After(n.notes[j].UpdatedAt)
	})
	return n.notes
}

// Reload re-scans the notes folder, picking up external changes
func (n *NotesService) Reload() error {
	if n.dir == "" {
		return errors.New("no notes folder selected")
	}
	return n.loadFolder(n.dir)
}

// Create a new note and writes it to disk
func (n *NotesService) Create(title, content string) (Note, error) {
	if n.dir == "" {
		return Note{}, errors.New("no notes folder selected")
	}
	note := Note{
		ID:        generateID(),
		Title:     title,
		Content:   content,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	if err := n.writeNote(&note); err != nil {
		return Note{}, err
	}
	n.notes = append(n.notes, note)
	return note, nil
}

// Update updates an existing note and rewrites its file
func (n *NotesService) Update(id, title, content string) error {
	for i := range n.notes {
		if n.notes[i].ID == id {
			n.notes[i].Title = title
			n.notes[i].Content = content
			n.notes[i].UpdatedAt = time.Now()
			return n.writeNote(&n.notes[i])
		}
	}
	return errors.New("note not found")
}

// Delete a note and removes its file
func (n *NotesService) Delete(id string) error {
	for i := range n.notes {
		if n.notes[i].ID == id {
			if fname, ok := n.files[id]; ok {
				if err := os.Remove(filepath.Join(n.dir, fname)); err != nil && !os.IsNotExist(err) {
					return err
				}
				delete(n.files, id)
			}
			n.notes = append(n.notes[:i], n.notes[i+1:]...)
			return nil
		}
	}
	return errors.New("note not found")
}

// loadFolder scans a directory for .md files and parses them into notes
func (n *NotesService) loadFolder(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	notes := make([]Note, 0)
	files := make(map[string]string)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".md") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		note := parseNote(string(data))
		if note.ID == "" {
			// Plain markdown file without frontmatter
			info, _ := e.Info()
			note.ID = "f-" + e.Name()
			if info != nil {
				note.CreatedAt = info.ModTime()
				note.UpdatedAt = info.ModTime()
			}
		}
		if note.Title == "" {
			note.Title = strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		}
		notes = append(notes, note)
		files[note.ID] = e.Name()
	}
	n.notes = notes
	n.files = files
	return nil
}

// writeNote serializes a note with frontmatter, handling filename changes
func (n *NotesService) writeNote(note *Note) error {
	fname := n.filenameFor(note)
	old, had := n.files[note.ID]
	data := serializeNote(note)
	if err := os.WriteFile(filepath.Join(n.dir, fname), []byte(data), 0o644); err != nil {
		return err
	}
	if had && old != fname {
		os.Remove(filepath.Join(n.dir, old))
	}
	n.files[note.ID] = fname
	return nil
}

// filenameFor derives a slug filename, avoiding collisions with other notes
func (n *NotesService) filenameFor(note *Note) string {
	slug := slugify(note.Title)
	if slug == "" {
		slug = note.ID
	}
	fname := slug + ".md"
	for id, existing := range n.files {
		if existing == fname && id != note.ID {
			fname = slug + "-" + note.ID + ".md"
			break
		}
	}
	return fname
}

var nonSlug = regexp.MustCompile(`[^a-z0-9-]+`)

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, " ", "-")
	s = nonSlug.ReplaceAllString(s, "")
	s = strings.Trim(s, "-")
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}

// serializeNote produces markdown with YAML frontmatter
func serializeNote(note *Note) string {
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "id: %s\n", note.ID)
	fmt.Fprintf(&b, "title: %s\n", note.Title)
	fmt.Fprintf(&b, "createdAt: %s\n", note.CreatedAt.Format(time.RFC3339Nano))
	fmt.Fprintf(&b, "updatedAt: %s\n", note.UpdatedAt.Format(time.RFC3339Nano))
	b.WriteString("---\n")
	b.WriteString(note.Content)
	return b.String()
}

// parseNote extracts frontmatter; returns zero-ID note if none present
func parseNote(data string) Note {
	var note Note
	if !strings.HasPrefix(data, "---\n") {
		note.Content = data
		return note
	}
	rest := data[4:]
	end := strings.Index(rest, "\n---\n")
	if end == -1 {
		note.Content = data
		return note
	}
	for _, line := range strings.Split(rest[:end], "\n") {
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		switch strings.TrimSpace(key) {
		case "id":
			note.ID = val
		case "title":
			note.Title = val
		case "createdAt":
			note.CreatedAt, _ = time.Parse(time.RFC3339Nano, val)
		case "updatedAt":
			note.UpdatedAt, _ = time.Parse(time.RFC3339Nano, val)
		}
	}
	note.Content = rest[end+5:]
	return note
}

func generateID() string {
	return time.Now().Format("20060102150405.000000")
}

// --- config persistence ---

type appConfig struct {
	Folder string `json:"folder"`
}

func configPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "cozyy-notes", "config.json")
}

func loadConfig() string {
	p := configPath()
	if p == "" {
		return ""
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	var cfg appConfig
	if json.Unmarshal(data, &cfg) != nil {
		return ""
	}
	return cfg.Folder
}

func saveConfig(folder string) {
	p := configPath()
	if p == "" {
		return
	}
	os.MkdirAll(filepath.Dir(p), 0o755)
	data, _ := json.Marshal(appConfig{Folder: folder})
	os.WriteFile(p, data, 0o644)
}
