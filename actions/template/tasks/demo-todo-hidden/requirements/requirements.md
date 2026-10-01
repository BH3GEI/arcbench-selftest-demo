# Todo app

Build a small web app for managing a todo list.

## Requirements

- The page shows a heading literally titled "Todos".
- A labeled text input "What needs to be done?" plus a button labeled "Add"
  lets the user add a new todo by its title.
- Submitting with an empty title shows the text "Title is required" and does
  not add an item.
- Each todo in the list has a "Delete" button that removes it.
- Todos persist across a page reload (not just in memory).
- The app listens on the port given by the `PORT` environment variable.
- The submission's root directory contains a `Dockerfile` that builds and
  runs the app with no other services required.

## Notes

This is the demo task shipped with the GitHub Actions grader template — it
exercises the full pipeline (build, isolated run, Playwright pack, pass/fail,
hidden-visibility masking) end to end. Swap in a real task by replacing this
folder's contents; the structure (`requirements/` + `tests/`) does not change.
