# Nested Collections Guide

This guide explains how to use the new **Nested Collections** feature to organize your audiobooks into hierarchical folders and series.

## Overview

The nested collections feature allows you to:
- Create **parent folders** (e.g., "Series", "Authors", "Genres")
- Create **subfolders** inside parent folders (e.g., "Harry Potter", "Percy Jackson")
- Organize books into a hierarchical structure
- View all books from a folder **and its subfolders** together

## Quick Start

### Creating a Top-Level Folder

1. Click the **"Create Collection"** button in the Collections panel
2. Enter a folder name (e.g., "Fantasy Series")
3. Choose a color (optional)
4. Leave **"Parent Folder"** as **"Top level"**
5. Click **Save**

Your folder now appears in the Collections sidebar.

### Creating a Subfolder

#### Method 1: Using the "+" Button
1. Hover over any folder in the Collections sidebar
2. Click the **"+"** button that appears on the right
3. Enter a subfolder name (e.g., "Harry Potter")
4. Choose a color (optional)
5. The parent folder is **automatically selected**
6. Click **Save**

#### Method 2: Using the Modal Dropdown
1. Click **"Create Collection"** button
2. Enter a folder name
3. In the **"Parent Folder"** dropdown, select the parent folder
4. Click **Save**

## Features

### Hierarchical Folder View

The Collections sidebar displays your folders as a tree:

```
📚 Fantasy Series          ← Parent folder
  ↳ Harry Potter         ← Subfolder (indented)
    ↳ Book 1
    ↳ Book 2
  ↳ Percy Jackson        ← Another subfolder
    ↳ Book 1
    ↳ Book 2
📚 Mystery Series        ← Another parent folder
  ↳ Agatha Christie
```

**Visual Indicators:**
- Indentation shows folder depth
- Small arrow (↳) appears next to subfolders
- Click any folder to view its books

### Viewing Books in a Folder

When you click a folder:
- You see **all books** directly in that folder
- You also see **all books from nested subfolders**
- This works recursively (subfolders of subfolders, etc.)

**Example:**
- "Fantasy Series" contains: Harry Potter, Percy Jackson books
- "Harry Potter" contains: Book 1, Book 2
- Clicking "Fantasy Series" shows all books at once

### Parent Folder Selector

When creating or editing a collection:

```
Parent Folder: [Dropdown ▼]
  • Top level
  • Fantasy Series
    - Harry Potter
    - Percy Jackson
  • Mystery Series
```

**Rules:**
- Select "Top level" to create a root folder
- Select any folder to make it a parent
- Subfolders are shown indented for clarity
- You cannot select a folder as its own parent (prevented automatically)

## Workflow Examples

### Example 1: Organize by Author

```
📚 Stephen King
  ↳ The Dark Tower
  ↳ It
  ↳ Carrie
📚 J.K. Rowling
  ↳ Harry Potter
  ↳ The Casual Vacancy
```

**Steps:**
1. Create "Stephen King" as top-level folder
2. Create "The Dark Tower" as subfolder → parent: "Stephen King"
3. Add books to each folder
4. Repeat for other authors

### Example 2: Organize by Series with Books

```
📚 My Audiobooks
  ↳ Harry Potter Series
    ↳ Chamber of Secrets
    ↳ Prisoner of Azkaban
  ↳ Lord of the Rings
    ↳ Fellowship
    ↳ Two Towers
```

**Steps:**
1. Create "My Audiobooks" (top-level)
2. Create "Harry Potter Series" → parent: "My Audiobooks"
3. Create "Chamber of Secrets" → parent: "Harry Potter Series"
4. Add audio files to innermost folders

### Example 3: Genre + Mood Organization

```
📚 Fiction
  ↳ Fantasy
    ↳ Epic Fantasy
    ↳ Urban Fantasy
  ↳ Mystery
📚 Non-Fiction
  ↳ Self-Help
  ↳ Biographies
```

## Tips & Best Practices

### ✓ Do's

- **Use 2-3 levels max** for easy navigation
- **Create meaningful folder names** ("Harry Potter" vs "HP1")
- **Use colors** to distinguish series or genres
- **Start simple** — you can reorganize later
- **Test deeply nested folders** — nesting 4+ levels may feel cluttered

### ✗ Don'ts

- Don't create too many top-level folders (keep sidebar clean)
- Don't use the same folder name twice in different parents
- Don't nest more than 4-5 levels deep (hard to navigate)

## Technical Details

### How Nesting Is Stored

Collections are stored in the database with a `parent_id` field:

```
Collection: "Harry Potter"
├── parent_id: 5 (points to "Fantasy Series")
├── name: "Harry Potter"
└── color: "#c8a96e"

Collection: "Fantasy Series"
├── parent_id: null (top-level)
├── name: "Fantasy Series"
└── color: "#a89968"
```

### Book Filtering

When you select a folder, the app uses a **recursive query** to find:
- Books directly in that folder
- Books in all subfolders
- Books in all sub-subfolders
- And so on...

This happens instantly with no performance impact.

### Data Persistence

- All folders and nesting relationships are **automatically saved** to the database
- Deleting a parent folder **does not delete subfolders** (they become top-level)
- Books remain in the database even if their folder is deleted

## Troubleshooting

### "I can't see my subfolders"
- **Solution:** Refresh the app (F5 or Ctrl+R)
- Check the Collections sidebar for indented items

### "The parent folder dropdown is empty"
- **Solution:** Create a top-level folder first
- Only existing folders appear in the dropdown

### "My deeply nested folders are hard to navigate"
- **Solution:** Flatten the structure (move subfolders to top-level)
- Use colors to help distinguish between similar folders

### "I deleted a folder and lost my books"
- **Solution:** The books are still in the database, just unassigned
- Create a new folder and re-add books
- Check database backups if available

## Keyboard Shortcuts

(If implemented in the future)
- `Ctrl+Shift+N` — Create new collection
- `Ctrl+Alt+N` — Create subfolder under current collection
- `Del` — Delete selected collection

## API Reference (For Developers)

### Create Collection with Parent

```javascript
window.sonara.collections.create(name, color, parentId);
// Example:
window.sonara.collections.create("Harry Potter", "#c8a96e", 5);
// parentId=5 means "Harry Potter" is a subfolder of folder with id=5
```

### Get All Books (Including Descendants)

```javascript
// Internally, the app uses:
db.getCollectionBooks(collectionId);
// This returns all books from the collection + all nested subfolders
```

## Future Enhancements

Potential features to request:
- [ ] Drag-and-drop to reorganize folders
- [ ] Bulk move books between folders
- [ ] Folder templates (pre-configured structures)
- [ ] Search within a folder hierarchy
- [ ] Export folder structure as outline
- [ ] Duplicate folder with all contents

## Support

For issues or feature requests:
1. Check the [TROUBLESHOOTING.md](TROUBLESHOOTING.md) file
2. Review app logs in DevTools (F12)
3. Report bugs with examples of your folder structure

---

**Version:** 2.0.0  
**Last Updated:** April 10, 2026  
**Feature:** Nested Collections / Hierarchical Folders
