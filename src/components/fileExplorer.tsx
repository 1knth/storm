import { useState } from 'react'
import { RiMenuUnfold4Fill } from "react-icons/ri";

export default function FileExplorer() {
	const [vaultPath, setVaultPath] = useState<string | null>(null)
	const chooseVault = async () => {
		const selectedPath = await window.vault.choose()
		if (selectedPath) setVaultPath(selectedPath)
	}
	const list = [2,3,4]
	// const notes = list.map((e) => {
	// 	return (
	// 		e
	// 	)
	// })

	return (
		<div className="flex flex-col p-5 rounded-3xl bg-black my-4 ml-4 h-[calc(100vh-2rem)] w-fit min-w-100 text-white select-none">
			<div className="flex flex-row items-center justify-between">
				<h1 className="text-xl font-bold">Directory</h1>
				<RiMenuUnfold4Fill className="cursor-pointer hover:opacity-70"/>
			</div>
			<div className="flex flex-col gap-4 mt-6">
				<button type="button" onClick={chooseVault} className="rounded-lg bg-white/10 px-3 py-2 text-left hover:bg-white/20">
					{vaultPath ? 'Change vault' : 'Open vault'}
				</button>
				{vaultPath && <p className="break-all text-sm text-white/70" title={vaultPath}>{vaultPath}</p>}
				{list}
			</div>
		</div>
	)
}
