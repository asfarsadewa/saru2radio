import { execFile } from 'node:child_process';

export async function pickFolderWithDialog(): Promise<string> {
	const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose music folder for saru2radio'
$dialog.ShowNewFolderButton = $false
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($dialog.SelectedPath)
}
`;

	return new Promise((resolve, reject) => {
		execFile(
			'powershell',
			['-NoProfile', '-STA', '-Command', script],
			{ windowsHide: false },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(stderr || error.message));
					return;
				}

				const selected = stdout.trim();
				if (!selected) {
					reject(new Error('No folder selected.'));
					return;
				}

				resolve(selected);
			}
		);
	});
}
