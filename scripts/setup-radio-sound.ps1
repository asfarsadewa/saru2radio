$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Resolve-Path (Join-Path $ScriptDir '..')
$ToolSourceDir = Join-Path $RootDir 'tools\make-radio-sound'
$RuntimeDir = Join-Path $RootDir '.tools\make-radio-sound'
$VenvDir = Join-Path $RuntimeDir 'venv'
$BuildDir = Join-Path $RuntimeDir 'build'
$ExePath = Join-Path $RuntimeDir 'make-radio-sound.exe'
$PythonExe = Join-Path $VenvDir 'Scripts\python.exe'

function Invoke-Checked {
	param(
		[Parameter(Mandatory = $true)]
		[string] $FilePath,
		[string[]] $Arguments = @()
	)

	& $FilePath @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
	}
}

function Find-Python {
	$pyLauncher = Get-Command py -ErrorAction SilentlyContinue
	if ($pyLauncher) {
		return @($pyLauncher.Source, '-3')
	}

	$python = Get-Command python -ErrorAction SilentlyContinue
	if ($python) {
		return @($python.Source)
	}

	throw 'Python was not found. Install Python 3, then run bun run setup:radio-sound again.'
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

if (-not (Test-Path $PythonExe)) {
	$pythonCommand = Find-Python
	$pythonLauncher = $pythonCommand[0]
	$pythonArguments = @()
	if ($pythonCommand.Length -gt 1) {
		$pythonArguments = $pythonCommand[1..($pythonCommand.Length - 1)]
	}
	Write-Host "[venv] $VenvDir"
	Invoke-Checked -FilePath $pythonLauncher -Arguments @($pythonArguments + @('-m', 'venv', $VenvDir))
}

Write-Host '[pip] installing make-radio-sound build dependencies'
Invoke-Checked -FilePath $PythonExe -Arguments @('-m', 'pip', 'install', '--upgrade', 'pip')
Invoke-Checked -FilePath $PythonExe -Arguments @('-m', 'pip', 'install', '-r', (Join-Path $ToolSourceDir 'requirements.txt'))

Write-Host "[build] $ExePath"
Push-Location $ToolSourceDir
try {
	Invoke-Checked -FilePath $PythonExe -Arguments @(
		'-m',
		'PyInstaller',
		'--noconfirm',
		'--clean',
		'--distpath',
		$RuntimeDir,
		'--workpath',
		$BuildDir,
		'.\make-radio-sound.spec'
	)
} finally {
	Pop-Location
}

if (-not (Test-Path $ExePath)) {
	throw "Expected executable was not created: $ExePath"
}

Write-Host "[done] $ExePath"
