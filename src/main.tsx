import React from 'react';
import './index.css';
import {createRoot} from "react-dom/client";
import FileExplorer from "./components/fileExplorer.tsx"
import Editor from "./components/Editor/Editor.tsx"
function App() {
	
	return (
		<main className="flex flex-row bg-gray-600 justify-left w-screen min-h-screen">
			<FileExplorer/>
			<Editor/>
		</main>	
	)
}

createRoot(document.getElementById("root")!).render(<App/>);
