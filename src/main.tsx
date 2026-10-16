import React, { useRef, useState } from 'react';
import './index.css';
import {createRoot} from "react-dom/client";
import FileExplorer from "./components/fileExplorer.tsx"
import Editor from "./components/Editor/Editor.tsx"
import type { NoteData } from './shared/types';

function App() {
	const [selectedNote, setSelectedNote] = useState<NoteData | null>(null)
	const [selectedNoteLoading, setSelectedNoteLoading] = useState(false)
	const [selectedNoteError, setSelectedNoteError] = useState<string | null>(null)
	const requestId = useRef(0)

	const selectNote = async (path: string) => {
		const currentRequest = ++requestId.current
		setSelectedNote(null)
		setSelectedNoteLoading(true)
		setSelectedNoteError(null)
		try {
			const note = await window.vault.readNote(path)
			if (currentRequest === requestId.current) setSelectedNote(note)
		} catch (error) {
			if (currentRequest === requestId.current) setSelectedNoteError(error instanceof Error ? error.message : 'Unable to read note')
		} finally {
			if (currentRequest === requestId.current) setSelectedNoteLoading(false)
		}
	}

	const clearSelectedNote = () => {
		requestId.current++
		setSelectedNote(null)
		setSelectedNoteLoading(false)
		setSelectedNoteError(null)
	}

	return (
		<main className="flex flex-row  justify-left w-screen min-h-screen">
			<FileExplorer onNoteSelect={selectNote} onVaultChange={clearSelectedNote}/>
			<Editor selectedNote={selectedNote} loading={selectedNoteLoading} error={selectedNoteError}/>
		</main>	
	)
}

createRoot(document.getElementById("root")!).render(<App/>);
