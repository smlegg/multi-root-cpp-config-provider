import * as vscode from 'vscode';
import * as cpptools from 'vscode-cpptools';
import * as fs from 'fs';
import * as jsonc from 'comment-json';
import * as path from 'path';

let multiRootProvider: MultiRootCppConfigProvider | null = null;
let cppToolsApi: cpptools.CppToolsApi | undefined = undefined;
let extensionContext: vscode.ExtensionContext | undefined = undefined;
const disposables: vscode.Disposable[] = [];

interface FolderBrowseConfig
{
	path: string[]
}

interface FolderConfig
{
	name: string
	browse?: FolderBrowseConfig
	includePath?: string[]
	defines?: string[]
	intelliSenseMode?: "linux-clang-x86" | "linux-clang-x64" | "linux-clang-arm" | "linux-clang-arm64" | "linux-gcc-x86" | "linux-gcc-x64" | "linux-gcc-arm" | "linux-gcc-arm64" | "macos-clang-x86" | "macos-clang-x64" | "macos-clang-arm" | "macos-clang-arm64" | "macos-gcc-x86" | "macos-gcc-x64" | "macos-gcc-arm" | "macos-gcc-arm64" | "windows-clang-x86" | "windows-clang-x64" | "windows-clang-arm" | "windows-clang-arm64" | "windows-gcc-x86" | "windows-gcc-x64" | "windows-gcc-arm" | "windows-gcc-arm64" | "windows-msvc-x86" | "windows-msvc-x64" | "windows-msvc-arm" | "windows-msvc-arm64" | "msvc-x86" | "msvc-x64" | "msvc-arm" | "msvc-arm64" | "gcc-x86" | "gcc-x64" | "gcc-arm" | "gcc-arm64" | "clang-x86" | "clang-x64" | "clang-arm" | "clang-arm64"
	cppStandard?:  "c89" | "c99" | "c11" | "c17" | "c++98" | "c++03" | "c++11" | "c++14" | "c++17" | "c++20" | "c++23" | "gnu89" | "gnu99" | "gnu11" | "gnu17" | "gnu++98" | "gnu++03" | "gnu++11" | "gnu++14" | "gnu++17" | "gnu++20" | "gnu++23"
	forcedInclude?: string[]
	compilerPath?: string
	compilerArgs?: string[]
	windowsSdkVersion?: string
}

interface FolderSettings
{
	name: string
	configurations: FolderConfig[]
}

interface IndexableQuickPickItem extends vscode.QuickPickItem
{
    index: number;
}

class MultiRootCppConfigProvider implements cpptools.CustomConfigurationProvider
{
	readonly name = "Multi-root";
	readonly extensionId = "multi-root-cpp-config-provider";

	configIndex: Map<string, number> = new Map<string, number>;
	configNames: string[] = [];
	configs: Map<string, FolderConfig[]> = new Map<string, FolderConfig[]>;
	currentConfig = 0;
	configStatusBarItem: vscode.StatusBarItem;
	disposables: vscode.Disposable[] = [];
	configWatcher: vscode.FileSystemWatcher | undefined = undefined;

	constructor()
	{
		let configToolTip = 'Multi-root C/C++ configuration';
		this.configStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
		this.configStatusBarItem.name = configToolTip;
		this.configStatusBarItem.tooltip = configToolTip;
		this.configStatusBarItem.command =
		{
			command: "multiRootCppConfig.ConfigurationSelect",
			title: configToolTip
		};

		this.refreshConfig(extensionContext?.workspaceState.get("MultiRootCPP.currentConfig"));

		this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) =>
		{
			if (e.affectsConfiguration("multiRootCppConfig"))
			{
				this.refreshConfig(this.configNames[this.currentConfig]);
			}
		}));
	}

	dispose()
	{
	}

	async refreshConfig(prevConfigName: string | undefined = undefined)
	{
		this.configIndex.clear();
		this.configNames = [];
		this.configs.clear();


		let folders: FolderSettings[] | undefined = undefined;

		let fileName: string | undefined = vscode.workspace.getConfiguration('multiRootCppConfig').get('file');
		if (fileName)
		{
			let uri = vscode.Uri.file(path.join(path.dirname(vscode.workspace.workspaceFile?.fsPath ?? "/"), fileName));
			const readResults = fs.readFileSync(uri.fsPath, 'utf8');
			const json = jsonc.parse(readResults);
			if (json)
			{
				folders = json["multiRootCppConfig.folders"];
				this.configWatcher = vscode.workspace.createFileSystemWatcher(uri.fsPath);
				this.disposables.push(this.configWatcher);
				this.configWatcher.onDidChange((e) => {
					this.refreshConfig(this.configNames[this.currentConfig]);
				});
			}
		}

		if (!folders)
		{
			folders = vscode.workspace.getConfiguration('multiRootCppConfig').get('folders');
		}

		if (folders)
		{
			folders.forEach((folder): void =>
			{
				folder.configurations.forEach((config): void =>
				{
					if (!this.configIndex.has(config.name))
					{
						this.configIndex.set(config.name, this.configIndex.size);
						this.configNames.push(config.name);
					}
				});
			});

			folders.forEach((folder): void =>
			{
				let folderConfigs = new Array<FolderConfig>(this.configIndex?.size ?? 0);
				folder.configurations.forEach((config): void =>
				{
					let index = this.configIndex.get(config.name);
					if (index !== undefined)
					{
						folderConfigs[index] = config;
					}
				});
				this.configs?.set(folder.name, folderConfigs);
			});
		}

		this.currentConfig = 0;
		if (prevConfigName)
		{
			let index = this.configIndex.get(prevConfigName);
			if (index !== undefined)
			{
				this.currentConfig = index;
			}
		}

		this.updateStatusBar();

		extensionContext?.workspaceState.update("MultiRootCPP.currentConfig", this.configStatusBarItem.text)

		cppToolsApi?.didChangeCustomConfiguration(this);
		cppToolsApi?.didChangeCustomBrowseConfiguration(this);
	}

	async canProvideConfiguration(uri: vscode.Uri, token?: any)
	{
		let folder = vscode.workspace.getWorkspaceFolder(uri);
		if (folder?.name && this.configs.has(folder.name))
		{
			return true;
		} else
		{
			return false;
		}
	}

	async provideConfigurations(uris: vscode.Uri[], token?: vscode.CancellationToken)
	{
		let items: cpptools.SourceFileConfigurationItem[] = [];
		uris.forEach((uri): void =>
		{
			let folder = vscode.workspace.getWorkspaceFolder(uri);
			if (folder?.name)
			{
				let folderConfigs = this.configs.get(folder.name);
				if (folderConfigs)
				{
					let config = folderConfigs[this.currentConfig];
					if (config)
					{
						items.push(
						{
							uri: uri,
							configuration: {
								includePath: config.includePath ?? [],
								defines: config.defines ?? [],
								intelliSenseMode: config.intelliSenseMode,
								standard: config.cppStandard,
								forcedInclude: config.forcedInclude,
								compilerPath: config.compilerPath,
								compilerArgs: config.compilerArgs,
								windowsSdkVersion: config.windowsSdkVersion
							}
						});
					}
				}
			}
		});

		return items;
	}

	async canProvideBrowseConfiguration(token?: any)
	{
		return false;
	}

	async provideBrowseConfiguration(token?: any)
	{
		return { browsePath: [] };
	}

	async canProvideBrowseConfigurationsPerFolder(token?: vscode.CancellationToken)
	{
		return true;
	}

	async provideFolderBrowseConfiguration(uri: vscode.Uri, token?: vscode.CancellationToken | undefined)
	{
		let folder = vscode.workspace.getWorkspaceFolder(uri);
		if (folder?.name)
		{
			let folderConfigs = this.configs.get(folder.name);
			if (folderConfigs)
			{
				let config = folderConfigs[this.currentConfig];
				if (config?.browse)
				{
					return {
						browsePath: config.browse?.path,
						compilerPath: config.compilerPath,
						compilerArgs: config.compilerArgs,
						standard: config.cppStandard,
						windowsSdkVersion: config.windowsSdkVersion
					};
				}
			}
		}

		return null;
	}

	async updateStatusBar()
	{
		let configName = this.configNames[this.currentConfig];
		this.configStatusBarItem.text = configName ?? "(no config)";
		if (configName)
		{
			this.configStatusBarItem.show();
		} else
		{
			this.configStatusBarItem.hide();
		}
	}

	async onSelectConfiguration()
	{
		let items: IndexableQuickPickItem[] = [];
		for (let i: number = 0; i < this.configNames.length; i++)
		{
			items.push({ label: this.configNames[i], index: i});
		}
		let selection: IndexableQuickPickItem | undefined = await vscode.window.showQuickPick(items);
		if (selection && selection.index !== this.currentConfig)
		{
			this.currentConfig = selection.index;
			this.updateStatusBar();
			extensionContext?.workspaceState.update("MultiRootCPP.currentConfig", this.configStatusBarItem.text)
			cppToolsApi?.didChangeCustomConfiguration(this);
			cppToolsApi?.didChangeCustomBrowseConfiguration(this);
		}
	}

	async getCurrentConfigName()
	{
		return this.configNames[this.currentConfig];
	}
}

export async function activate(context: vscode.ExtensionContext)
{
	cppToolsApi = await cpptools.getCppToolsApi(cpptools.Version.latest);
	if (cppToolsApi)
	{
		extensionContext = context;
		multiRootProvider = new MultiRootCppConfigProvider;

		if (!!cppToolsApi.notifyReady)
		{
			cppToolsApi.registerCustomConfigurationProvider(multiRootProvider);
			// do setup
			cppToolsApi.notifyReady(multiRootProvider);
		} else
		{
			//
			// do setup
			cppToolsApi.registerCustomConfigurationProvider(multiRootProvider);
			cppToolsApi.didChangeCustomConfiguration(multiRootProvider);
		}

		disposables.push(vscode.commands.registerCommand('multiRootCppConfig.ConfigurationSelect', () => { multiRootProvider?.onSelectConfiguration(); }));
		disposables.push(vscode.commands.registerCommand('multiRootCppConfig.activeConfigName', () => { return multiRootProvider?.getCurrentConfigName(); }))
	}
}

export function deactivate()
{
    disposables.forEach(d => d.dispose());

	if (multiRootProvider)
	{
		multiRootProvider.dispose();
	}
	if (cppToolsApi)
	{
		cppToolsApi.dispose();
	}

	extensionContext = undefined;
}
