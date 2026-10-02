# start.ps1 - Windows/PowerShell launcher for the Millersoft Data Vault stack.
#
# Examples:
#   .\start.ps1
#   .\start.ps1 --build
#   .\start.ps1 --demo
#   .\start.ps1 --build --demo
#   .\start.ps1 --fdw
#   .\start.ps1 --build --fdw
#   .\start.ps1 --external-postgres
#   .\start.ps1 --build --external-postgres
#   .\start.ps1 --build -d
#   .\start.ps1 --build --demo -d
#   .\start.ps1 --build --external-postgres -d
#   .\start.ps1 up --build
#   .\start.ps1 up --build --demo
#   .\start.ps1 up --build --external-postgres
#   .\start.ps1 down
#   .\start.ps1 down -v
#   .\start.ps1 logs -f hop
#   .\start.ps1 ps
#   .\start.ps1 --reset-license --build
#   .\start.ps1 --force-license-prompt --build
#   .\start.ps1 --license-status

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = "Stop"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptRoot

# Container engine can be supplied directly in the environment or configured
# in .env. An explicitly supplied environment variable takes precedence.
if (-not $env:CONTAINER_ENGINE) {
    $EnvFile = Join-Path $ScriptRoot ".env"

    if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
        $ContainerEngineLine = Get-Content -LiteralPath $EnvFile |
            Where-Object { $_ -match '^\s*CONTAINER_ENGINE\s*=' } |
            Select-Object -Last 1

        if ($ContainerEngineLine) {
            $ContainerEngineValue = ($ContainerEngineLine -split '=', 2)[1].Trim()

            # Remove optional matching single/double quotes.
            if (
                ($ContainerEngineValue.StartsWith('"') -and $ContainerEngineValue.EndsWith('"')) -or
                ($ContainerEngineValue.StartsWith("'") -and $ContainerEngineValue.EndsWith("'"))
            ) {
                $ContainerEngineValue = $ContainerEngineValue.Substring(
                    1,
                    $ContainerEngineValue.Length - 2
                )
            }

            $env:CONTAINER_ENGINE = $ContainerEngineValue
        }
    }
}

if (-not $env:CONTAINER_ENGINE) {
    $env:CONTAINER_ENGINE = "docker"
}

$LicenseFile = if ($env:LICENSE_FILE) {
    $env:LICENSE_FILE
} else {
    Join-Path $ScriptRoot "LICENSE"
}

$LicenseStateDir = if ($env:LICENSE_STATE_DIR) {
    $env:LICENSE_STATE_DIR
} else {
    Join-Path $ScriptRoot ".license-state"
}

$LicenseMarker = Join-Path $LicenseStateDir "license.accepted"

function Test-Truthy {
    param([string]$Value)

    return $Value -match '^(true|TRUE|True|1|yes|YES|Yes|y|Y)$'
}

function Get-ComposeCommand {
    switch ($env:CONTAINER_ENGINE.ToLowerInvariant()) {
        "docker" {
            if (Get-Command docker -ErrorAction SilentlyContinue) {
                docker compose version *> $null

                if ($LASTEXITCODE -eq 0) {
                    return @("docker", "compose")
                }
            }

            if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
                docker-compose version *> $null

                if ($LASTEXITCODE -eq 0) {
                    return @("docker-compose")
                }
            }

            throw "Docker Compose is not available."
        }

        "podman" {
            if (!(Get-Command podman -ErrorAction SilentlyContinue)) {
                throw "Podman is not available."
            }

            podman info *> $null

            if ($LASTEXITCODE -ne 0) {
                throw "Podman Machine is not running. Run: podman machine start"
            }

            podman compose version *> $null

            if ($LASTEXITCODE -ne 0) {
                throw "Podman Compose is not available."
            }

            return @("podman", "compose")
        }

        default {
            throw "Unknown container engine '$($env:CONTAINER_ENGINE)'. Supported engines: docker, podman."
        }
    }
}

function Invoke-Compose {
    param(
        [string[]]$ComposeCommand,
        [string[]]$ComposeArgs
    )

    if ($ComposeCommand.Count -eq 2) {
        & $ComposeCommand[0] $ComposeCommand[1] @ComposeArgs
    } else {
        & $ComposeCommand[0] @ComposeArgs
    }

    exit $LASTEXITCODE
}

function Invoke-ComposeStep {
    param(
        [string[]]$ComposeCommand,
        [string[]]$ComposeArgs
    )

    if ($ComposeCommand.Count -eq 2) {
        & $ComposeCommand[0] $ComposeCommand[1] @ComposeArgs
    } else {
        & $ComposeCommand[0] @ComposeArgs
    }

    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

function Add-ResourceComposeOverride {
    # Studio creates this ignored local file for user-selected container limits.
    # It layers over the tracked Compose definition without mutating it.
    $resourceFile = Join-Path $ScriptRoot "docker-compose.resources.yaml"
    if (Test-Path -LiteralPath $resourceFile -PathType Leaf) {
        $separator = [IO.Path]::PathSeparator
        $env:COMPOSE_FILE = "$($env:COMPOSE_FILE)${separator}docker-compose.resources.yaml"
    }
}

function Assert-LicenseFileExists {
    if (!(Test-Path -LiteralPath $LicenseFile -PathType Leaf)) {
        throw "License file not found at '$LicenseFile'. Create a LICENSE file next to docker-compose.yaml, then run .\start.ps1 --build again."
    }
}

function Get-LicenseHash {
    Assert-LicenseFileExists
    return (Get-FileHash -LiteralPath $LicenseFile -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-LicenseMarkerValid {
    if (!(Test-Path -LiteralPath $LicenseMarker -PathType Leaf)) {
        return $false
    }

    $currentHash = Get-LicenseHash
    $expectedLine = "license_sha256=$currentHash"

    $lines = Get-Content -LiteralPath $LicenseMarker -ErrorAction Stop
    return $lines -contains $expectedLine
}

function Write-LicenseMarker {
    Assert-LicenseFileExists

    if (!(Test-Path -LiteralPath $LicenseStateDir -PathType Container)) {
        New-Item -ItemType Directory -Path $LicenseStateDir -Force | Out-Null
    }

    $hash = Get-LicenseHash
    $acceptedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    $content = @(
        "license_sha256=$hash"
        "accepted_at_utc=$acceptedAt"
        "accepted_method=host start.ps1 launcher"
    ) -join "`n"

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($LicenseMarker, $content + "`n", $utf8NoBom)
}

function Show-LicenseMenu {
    Write-Host ""
    Write-Host "============================================================"
    Write-Host "LICENSE AGREEMENT"
    Write-Host "============================================================"
    Write-Host ""
    Write-Host "You must accept the license agreement before the ETL process can start."
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  Y - Accept license and start ETL"
    Write-Host "  N - Decline license and stop"
    Write-Host "  V - View full license text"
    Write-Host ""
}

function Ensure-LicenseAccepted {
    Assert-LicenseFileExists

    if (Test-LicenseMarkerValid) {
        Write-Host "License already accepted. Starting container deployment..."
        return
    }

    if (Test-Truthy $env:ACCEPT_LICENSE) {
        Write-LicenseMarker
        Write-Host "License accepted via ACCEPT_LICENSE=true. Starting container deployment..."
        return
    }

    while ($true) {
        Show-LicenseMenu
        $choice = Read-Host "Please choose Y, N, or V"

        switch -Regex ($choice) {
            '^[yY]([eE][sS])?$' {
                Write-LicenseMarker
                Write-Host ""
                Write-Host "License accepted. Starting container deployment..."
                Write-Host ""
                return
            }
            '^[nN]([oO])?$' {
                Write-Host ""
                Write-Host "License declined. Container deployment will not be started."
                Write-Host ""
                exit 1
            }
            '^[vV]$' {
                Write-Host ""
                Write-Host "==================== FULL LICENSE TEXT ===================="
                Get-Content -LiteralPath $LicenseFile | ForEach-Object { Write-Host $_ }
                Write-Host ""
                Write-Host "==========================================================="
                Write-Host ""
            }
            default {
                Write-Host ""
                Write-Host "Invalid option. Please enter Y, N, or V."
                Write-Host ""
            }
        }
    }
}

function Show-LicenseStatus {
    Assert-LicenseFileExists

    Write-Host "License file:   $LicenseFile"
    Write-Host "License state:  $LicenseStateDir"
    Write-Host "License marker: $LicenseMarker"
    Write-Host "License hash:   $(Get-LicenseHash)"

    if (Test-LicenseMarkerValid) {
        Write-Host "Status:         accepted"
    } else {
        Write-Host "Status:         not accepted"
    }
}

function Reset-License {
    if (Test-Path -LiteralPath $LicenseMarker -PathType Leaf) {
        Remove-Item -LiteralPath $LicenseMarker -Force
        Write-Host "Removed license marker: $LicenseMarker"
    } else {
        Write-Host "No license marker found at: $LicenseMarker"
    }
}

$ComposeCommand = Get-ComposeCommand

# Direct launcher commands such as `stop hop` and `ps` must use the same
# effective project as Studio-managed starts.
$env:COMPOSE_FILE = "docker-compose.yaml"
Add-ResourceComposeOverride

# Avoid Compose's attached-mode helper menu competing with normal logs.
if (-not $env:COMPOSE_MENU) {
    $env:COMPOSE_MENU = "false"
}

$RemainingArgs = @($Args)

$ResetLicense = $false
$ForceLicensePrompt = $false
$LicenseStatus = $false
$FilteredArgs = @()

foreach ($arg in $RemainingArgs) {
    switch ($arg) {
        "--reset-license" {
            $ResetLicense = $true
        }
        "--force-license-prompt" {
            $ForceLicensePrompt = $true
        }
        "--license-status" {
            $LicenseStatus = $true
        }
        default {
            $FilteredArgs += $arg
        }
    }
}

if ($LicenseStatus) {
    Show-LicenseStatus
    exit 0
}

if ($ResetLicense) {
    Reset-License
}

if ($ForceLicensePrompt) {
    Reset-License
}

if ($FilteredArgs.Count -eq 0) {
    $Subcommand = "up"
    $ComposeArgs = @()
} elseif ($FilteredArgs[0].StartsWith("-")) {
    $Subcommand = "up"
    $ComposeArgs = $FilteredArgs
} else {
    $Subcommand = $FilteredArgs[0]

    if ($FilteredArgs.Count -gt 1) {
        $ComposeArgs = $FilteredArgs[1..($FilteredArgs.Count - 1)]
    } else {
        $ComposeArgs = @()
    }
}

switch ($Subcommand) {
    "bootstrap-external-postgres" {
        Ensure-LicenseAccepted

        $ComposeFileSeparator = [IO.Path]::PathSeparator
        $env:COMPOSE_FILE = "docker-compose.yaml${ComposeFileSeparator}docker-compose.studio.yaml"
        Add-ResourceComposeOverride
        $env:DEMO_MODE = "false"
        $env:WAIT_FOR_MYSQL = "false"

        Invoke-ComposeStep `
            -ComposeCommand $ComposeCommand `
            -ComposeArgs @("--profile", "external-postgres-bootstrap", "build", "metadata-bootstrap")

        Invoke-ComposeStep `
            -ComposeCommand $ComposeCommand `
            -ComposeArgs @("--profile", "external-postgres-bootstrap", "run", "--rm", "metadata-bootstrap")

        exit 0
    }

    "up" {
        Ensure-LicenseAccepted

        $DemoMode = $false
        $ExternalPostgres = $false
        $FdwMode = $false
        $BuildRequested = $false
        $StudioBuild = $false
        $ComposeBuildForwarded = $false
        $CleanComposeArgs = @()

        foreach ($arg in $ComposeArgs) {
            switch ($arg) {
                "--demo" {
                    $DemoMode = $true
                }
                "--external-postgres" {
                    $ExternalPostgres = $true
                }
                "--fdw" {
                    $FdwMode = $true
                }
                "--build" {
                    $BuildRequested = $true
                    if (-not $ComposeBuildForwarded) {
                        $CleanComposeArgs += "--build"
                        $ComposeBuildForwarded = $true
                    }
                }
                "--studio-build" {
                    $StudioBuild = $true
                    $BuildRequested = $true
                    if (-not $ComposeBuildForwarded) {
                        $CleanComposeArgs += "--build"
                        $ComposeBuildForwarded = $true
                    }
                }
                default {
                    $CleanComposeArgs += $arg
                }
            }
        }

        $ComposeFileSeparator = [IO.Path]::PathSeparator
        if ($DemoMode -and $ExternalPostgres) {
            Write-Error "--demo and --external-postgres cannot be used together. The bundled Sakila demo is only supported with the internal PostgreSQL service."
            exit 1
        }

        if ($FdwMode -and $ExternalPostgres) {
            Write-Error "--fdw and --external-postgres cannot be used together. FDW mode requires the packaged PostgreSQL service."
            exit 1
        }

        if ($StudioBuild -and $ExternalPostgres) {
            Write-Error "--studio-build is only valid for Studio-managed internal PostgreSQL. Use --build with --external-postgres to keep the external bootstrap semantics."
            exit 1
        }

        if ($BuildRequested -and -not $StudioBuild -and -not $ExternalPostgres -and -not $FdwMode) {
            $env:COMPOSE_FILE = "docker-compose.yaml"
            Write-Host "Build requested. Packaged 03-ddls.sql is enabled and will run only when PostgreSQL initializes a new data volume."
        } else {
            $env:COMPOSE_FILE = "docker-compose.yaml${ComposeFileSeparator}docker-compose.studio.yaml"
        }

        if ($FdwMode) {
            $env:COMPOSE_FILE = "$($env:COMPOSE_FILE)${ComposeFileSeparator}docker-compose.fdw.yaml"
            Write-Host "FDW mode enabled for packaged PostgreSQL."
        }
        Add-ResourceComposeOverride

        if ($ExternalPostgres) {
            Write-Host "Starting in EXTERNAL POSTGRES mode."
            Write-Host "Internal PostgreSQL will not be started."
            Write-Host "Bundled Sakila MySQL source will not be started."

            $env:DEMO_MODE = "false"
            $env:WAIT_FOR_MYSQL = "false"

            if ($BuildRequested) {
                Write-Host "Build requested. Running external PostgreSQL bootstrap/setup only."
                Write-Host "Hop ETL will not be started in this step."

                Invoke-ComposeStep `
                    -ComposeCommand $ComposeCommand `
                    -ComposeArgs @("--profile", "external-postgres-bootstrap", "build", "metadata-bootstrap")

                Invoke-ComposeStep `
                    -ComposeCommand $ComposeCommand `
                    -ComposeArgs @("--profile", "external-postgres-bootstrap", "run", "--rm", "metadata-bootstrap")

                Write-Host "Building Hop image for later ETL launch."

                Invoke-ComposeStep `
                    -ComposeCommand $ComposeCommand `
                    -ComposeArgs @("build", "hop")

                Write-Host "External PostgreSQL setup complete."
                Write-Host "Create staging/Data Vault tables using the GUI, then launch ETL with:"
                Write-Host ""
                Write-Host "  .\start.ps1 --external-postgres"
                Write-Host ""

                exit 0
            } else {
                Write-Host "No --build flag provided. Skipping external PostgreSQL bootstrap."
                Write-Host "Starting Hop ETL against external PostgreSQL."

                Invoke-Compose `
                    -ComposeCommand $ComposeCommand `
                    -ComposeArgs (@("up") + $CleanComposeArgs)
            }
        }

        if ($DemoMode) {
            Write-Host "Starting in DEMO mode. Bundled Sakila MySQL source will be started."

            $env:DEMO_MODE = "true"
            $env:WAIT_FOR_MYSQL = "true"

            Invoke-Compose `
                -ComposeCommand $ComposeCommand `
                -ComposeArgs (@("--profile", "internal-postgres", "--profile", "demo", "up") + $CleanComposeArgs)
        }

        Write-Host "Starting in normal INTERNAL POSTGRES mode. Bundled Sakila MySQL source will not be started."

        $env:DEMO_MODE = "false"
        $env:WAIT_FOR_MYSQL = "false"

        Invoke-Compose `
            -ComposeCommand $ComposeCommand `
            -ComposeArgs (@("--profile", "internal-postgres", "up") + $CleanComposeArgs)
    }

    "down" {
        # Include all profiles so profiled services/volumes such as postgres/mysql/bootstrap
        # are cleaned up when using .\start.ps1 down -v.
        Invoke-Compose `
            -ComposeCommand $ComposeCommand `
            -ComposeArgs (@("--profile", "internal-postgres", "--profile", "demo", "--profile", "external-postgres-bootstrap", "down") + $ComposeArgs)
    }

    default {
        Invoke-Compose `
            -ComposeCommand $ComposeCommand `
            -ComposeArgs (@($Subcommand) + $ComposeArgs)
    }
}
