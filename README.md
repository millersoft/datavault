<img src="https://millersoft.co/img/millersoft-logo-large-small-50-github.png" alt="Millersoft Logo" height="50">

# Millersoft Data Vault Engine and Studio

The **Millersoft Data Vault Engine and Studio** provide an open source, metadata-driven foundation for building AI-ready analytical platforms using Data Vault architecture. The Engine automates repeatable Data Vault delivery patterns, including source integration, metadata processing, documentation, change handling, and refresh workflows. The Studio adds a visual, workflow-driven interface that helps teams model, manage, understand, and operate their Data Vault more effectively. Together, they provide the missing link between raw operational systems and believable AI analytics: integrated, historised, contextualised, and explainable data foundations that organisations can trust, extend, and build on.

## Index

- [Typical Data Vault architecture](#architecture)
- [Data Vault Studio](#studio)
- [Studio demonstration](#studio-demo)
- [Studio AI Insights demonstration](#studio-ai-demo)
- [Project history](#project-history)
- [Docker setup and configuration](docker_readme.md)

<a id="architecture"></a>

# Typical Data Vault Architecture with the Millersoft Engine
![Millersoft Data Vault Engine Architecture](/docs/img/data-vault-engine-architecture-github.png)
> The diagram above shows Actian/Ingres as the destination database for the data vault. Note: the data vault engine supports all databases through [Postgres Foreign Data Wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers) 

<a id="studio"></a>

# Data Vault Studio

The Data Vault Studio is a GUI interface that helps guide users to create their very own Data Vault. See the [Data Vault Studio guide](data_vault_studio/README.md).

<a id="studio-demo"></a>

## Watch Data Vault Studio in Action 
[![Watch Data Vault Studio in Action](https://img.youtube.com/vi/yintN1TDllY/maxresdefault.jpg)](https://youtu.be/yintN1TDllY)

<a id="studio-ai-demo"></a>

## Watch Data Vault Studio AI Insights in Action 
[![Watch Data Vault Studio in Action](https://img.youtube.com/vi/pdklhR4RTAc/maxresdefault.jpg)](https://youtu.be/pdklhR4RTAc)

<a id="project-history"></a>

## History of Data Vault Engine Project
[Link to Project History](https://millersoft.co/blog/open-source-data-vault-engine)

<a id="docker-setup"></a>

## Docker setup

Docker is used to run the Data Vault Engine and its supporting services. For prerequisites, installation, startup commands, demo mode, external PostgreSQL, licensing, and troubleshooting, see the [Docker setup guide](docker_readme.md).
