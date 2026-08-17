import React from "react";
import { createRoot } from "react-dom/client";

// Electron navigates to a dropped file by default. A drop that lands anywhere
// other than the composer would replace the app with the file's contents and
// leave no way back, so the document swallows every drop the composer did not
// already handle. The composer's own handler calls preventDefault first, so
// this never blocks a real attachment.
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (event) => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  });
}
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
