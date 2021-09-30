"use strict";

const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs');
const io = require('@actions/io');
const path = require('path');
const toolrunner = require('@actions/exec/lib/toolrunner');

const CMakeApiClientName = "client-msvc-ca-action";
// Paths relative to absolute path to cl.exe
const RelativeRulesetPath = '..\\..\\..\\..\\..\\..\\..\\..\\Team Tools\\Static Analysis Tools\\Rule Sets';
const RelativeToolsetPath = '..\\..\\..\\..';
const RelativeCommandPromptPath = '..\\..\\..\\..\\..\\..\\..\\Auxiliary\\Build\\vcvarsall.bat';

/**
 * Validate if the given directory both exists and is non-empty.
 * @returns Promise<string> true if the directory is empty
 */
function isDirectoryEmpty(buildRoot) {
  return !buildRoot || !fs.existsSync(buildRoot) || (fs.readdirSync(buildRoot).length) == 0;
}

/**
 * Validate if the given directory both exists and is non-empty.
 * @returns Promise<string> true if the directory is empty
 */
function isSubdirectory(parentDir, subDir) {
  return path.normalize(subDir).startsWith(path.normalize(parentDir));
}

/**
 * Get normalized relative path from a given file/directory.
 * @param {string} fromPath path to join relative path to
 * @param {string} relativePath relative path to append
 * @returns normalized path
 */
function getRelativeTo(fromPath, relativePath) {
  return path.normalize(path.join(fromPath, relativePath))
}

/**
 * Validate and resolve action input path by making non-absolute paths relative to
 * GitHub repository root.
 * @param {string} input name of GitHub action input variable
 * @param {boolean} required if true the input must be non-empty
 * @returns the absolute path to the input path if specified
 */
function resolveInputPath(input, required = false) {
  let inputPath = core.getInput(input);
  if (!inputPath) {
    if (required) {
      throw new Error(input + " input path can not be empty.");
    }
  }

  if (!path.isAbsolute(inputPath)) {
    // make path relative to the repo root if not absolute
    inputPath = path.join(process.env.GITHUB_WORKSPACE, inputPath);
  }

  return inputPath;
}

/**
 * Validate and resolve action input paths making non-absolute paths relative to
 * GitHub repository root. Paths are seperated by the provided string.
 * @param {string} input name of GitHub action input variable
 * @param {boolean} required if true the input must be non-empty
 * @returns the absolute path to the input path if specified
 */
function resolveInputPaths(input, required = false, seperator = ';') {
  const inputPaths = core.getInput(input);
  if (!inputPaths) {
    if (required) {
      throw new Error(input + " input paths can not be empty.");
    }

    return [];
  }

  return inputPaths.split(seperator)
    .map((inputPath) => resolveInputPath(inputPath))
    .filter((inputPath) => inputPath);
}

/**
 * Create a query file for the CMake API
 * @param {string} apiDir CMake API directory '.cmake/api/v1'
 */
async function createApiQuery(apiDir) {
  const queryDir = path.join(apiDir, "query", CMakeApiClientName);
  if (!fs.existsSync(queryDir)) {
    await io.mkdirP(queryDir);
  }

  const queryFile = path.join(queryDir, "query.json");
  const queryData = {
    "requests": [
      { kind: "codemodel", version: 2 },
      { kind: "toolchains", version: 1 }
  ]};

  try {
    fs.writeFileSync(queryFile, JSON.stringify(queryData), 'utf-8');
  } catch (err) {
    throw new Error("Failed to write query.json file for CMake API.", err);
  }
}

/**
 * Read and parse the given JSON reply file.
 * @param {string} replyFile absolute path to JSON reply
 * @returns parsed JSON data of the reply file
 */
function parseReplyFile(replyFile) {
  if (!fs.existsSync(replyFile)) {
    throw new Error("Failed to find CMake API reply file: " + replyFile);
  }

  let jsonData = fs.readFileSync(replyFile, (err) => {
    if (err) {
      throw new Error("Failed to read CMake API reply file: " + replyFile, err);
    }
  });

  return JSON.parse(jsonData);
}

/**
 * Get the JSON filepath for the given response kind.
 * @param {string} replyDir CMake API directory for replies '.cmake/api/v1/reply'
 * @param {object} indexReply parsed JSON data from index-xxx.json reply
 * @param {string} kind the kind of response to search for
 * @returns the absolute path to the JSON response file, null if not found
 */
function getResponseFilepath(replyDir, clientResponses, kind) {
  const response = clientResponses.find((response) => response["kind"] == kind);
  return response ? path.join(replyDir, response.jsonFile) : null;
}

/**
 * Information extracted from CMake API index reply which details all other requested responses.
 * @param {string} replyDir CMake API directory for replies '.cmake/api/v1/reply'
 * @param {object} indexReply parsed JSON data from index-xxx.json reply
 */
function ReplyIndexInfo(replyDir, indexReply) {
  const clientResponses = indexReply.reply[CMakeApiClientName]["query.json"].responses;
  this.codemodelResponseFile = getResponseFilepath(replyDir, clientResponses, "codemodel");
  this.toolchainsResponseFile = getResponseFilepath(replyDir, clientResponses, "toolchains");
  this.version = indexReply.cmake.version.string;
}

/**
 * Load the information needed from the reply index file for the CMake API
 * @param {string} apiDir CMake API directory '.cmake/api/v1'
 * @returns ReplyIndexInfo info extracted from index-xxx.json reply
 */
function getApiReplyIndex(apiDir) {
  const replyDir = path.join(apiDir, "reply");

  let indexFilepath;
  if (fs.existsSync(replyDir)) {
    for (const filename of fs.readdirSync(replyDir)) {
      if (filename.startsWith("index-")) {
        // get the most recent index query file (ordered lexicographically)
        const filepath = path.join(replyDir, filename);
        if (!indexFilepath || filepath > indexFilepath) {
          indexFilepath = filepath;
        }
      };
    }
  }

  if (!indexFilepath) {
    throw new Error("Failed to find CMake API index reply file.");
  }

  const indexReply = parseReplyFile(indexFilepath);
  const replyIndexInfo = new ReplyIndexInfo(replyDir, indexReply);

  core.info(`Loaded '${indexFilepath}' reply generated from CMake API.`);

  return replyIndexInfo;
}

/**
   * Load reply data from the CMake API. This will:
   *  - Create a query file in cmake API directory requesting data needed
   *  - Re-run CMake on build directory to generate reply data
   *  - Extract required information from the index-xxx.json reply
   *  - Validate the version of CMake to ensure required reply data exists
   * @param {string} buildRoot build directory of CMake project
   * @return ReplyIndexInfo info extracted from index-xxx.json reply
   */
async function loadCMakeApiReplies(buildRoot) {
  if (isDirectoryEmpty(buildRoot)) {
    throw new Error("CMake build root must exist, be non-empty and be configured with CMake");
  }

  // validate CMake can be found on the PATH
  await io.which("cmake", true);

  // create CMake API query file for the generation of replies needed
  const apiDir = path.join(buildRoot, ".cmake/api/v1");
  await createApiQuery(apiDir);

  // regenerate CMake build directory to acquire CMake file API reply
  core.info(`Running CMake to generate reply data.`);
  try {
    await exec.exec("cmake", [ buildRoot ])
  } catch (err) {
    throw new Error(`CMake failed to reconfigure project with error: ${err}`);
  }

  // load reply index generated from the CMake Api
  const replyIndexInfo = getApiReplyIndex(apiDir);
  if (replyIndexInfo.version < "3.20.5") {
    throw new Error("Action requires CMake version >= 3.20.5");
  }

  return replyIndexInfo;
}

/**
 * Information on compiler include path.
 * @param {string} path the absolute path to the include directory
 * @param {boolean} isSystem true if this should be treated as a CMake SYSTEM path
 */
function IncludePath(path, isSystem) {
  this.path = path;
  this.isSystem = isSystem;
}

/**
 * Information about the language and compiler being used to compile a source file.
 * @param {object} toolchain ReplyIndexInfo info extracted from index-xxx.json reply
 */
function ToolchainInfo(toolchain) {
  this.language = toolchain.language;
  this.path = toolchain.compiler.path;
  this.version = toolchain.compiler.version;
  this.includes = (toolchain.compiler.implicit.includeDirectories || []).map(
    (include) => new IncludePath(include, true));

  // extract toolset-version & host/target arch from folder layout in VS
  this.toolsetVersion = path.basename(getRelativeTo(this.path, RelativeToolsetPath));
  const targetDir = path.dirname(this.path);
  const hostDir = path.dirname(targetDir);
  this.targetArch = path.basename(targetDir);
  switch (path.basename(hostDir)) {
    case 'Hostx86':
      this.hostArch = 'x86';
      break;
    case 'Hostx64':
      this.hostArch = 'x64';
      break;
    default:
      throw new Error('Unknown MSVC toolset layout');
  }
}

/**
 * Parse the toolchain-xxx.json file to find information on any MSVC toolchains used. If none are
 * found issue an error.
 * @param {ReplyIndexInfo} replyIndexInfo ReplyIndexInfo info extracted from index-xxx.json reply
 * @returns Toolchain info extracted from toolchain-xxx.json
 */
function loadToolchainMap(replyIndexInfo) {
  if (!fs.existsSync(replyIndexInfo.toolchainsResponseFile)) {
    throw new Error("Failed to load toolchains response from CMake API");
  }

  const toolchainMap = {};
  const toolchains = parseReplyFile(replyIndexInfo.toolchainsResponseFile);
  const cToolchain = toolchains.toolchains.find(
    (t) => t.language == "C" && t.compiler.id == "MSVC");
  if (cToolchain) {
    toolchainMap[cToolchain.language] = new ToolchainInfo(cToolchain);
  }

  const cxxToolchain = toolchains.toolchains.find(
    (t) => t.language == "CXX" && t.compiler.id == "MSVC");
  if (cxxToolchain) {
    toolchainMap[cxxToolchain.language] = new ToolchainInfo(cxxToolchain);
  }


  if (Object.keys(toolchainMap).length === 0) {
    throw new Error("Action requires use of MSVC for either/both C or C++.");
  }

  return toolchainMap;
}

/**
 * Information on each compilation unit extracted from the CMake targets.
 * @param {object} group compilation data shared between one or more source files
 * @param {string} source absolute path to source file being compiled
 */
function CompileCommand(group, source) {
  // Filepath to source file being compiled
  this.source = source;
  // Compiler language used
  this.language = group.language;
  // C++ Standard
  this.standard = group.languageStandard ? group.languageStandard.standard : undefined;
  // Compile command line fragments appended into a single string
  this.args = (group.compileCommandFragments || []).map((c) => c.fragment).join(" ");
  // includes, both regular and system
  this.includes = (group.includes || []).map((inc) =>
    new IncludePath(inc.path, inc.isSystem || false));
  // defines
  this.defines = (group.defines || []).map((d) => d.define);
}

/**
 * Parse the codemodel-xxx.json and each target-xxx.json to find information on required to compile
 * each source file in the project.
 * @param {ReplyIndexInfo} replyIndexInfo ReplyIndexInfo info extracted from index-xxx.json reply
 * @returns CompileCommand information for each compiled source file in the project
 */
function loadCompileCommands(replyIndexInfo, excludedTargetPaths) {
  if (!fs.existsSync(replyIndexInfo.codemodelResponseFile)) {
    throw new Error("Failed to load codemodel response from CMake API");
  }

  let compileCommands = [];
  const codemodel = parseReplyFile(replyIndexInfo.codemodelResponseFile);
  const sourceRoot = codemodel.paths.source;
  const replyDir = path.dirname(replyIndexInfo.codemodelResponseFile);
  const codemodelInfo = codemodel.configurations[0];
  for (const targetInfo of codemodelInfo.targets) {
    const targetDir = path.join(sourceRoot, codemodelInfo.directories[targetInfo.directoryIndex].source);
    if (excludedTargetPaths.some((excludePath) => isSubdirectory(excludePath, targetDir))) {
      continue;
    }

    const target = parseReplyFile(path.join(replyDir, targetInfo.jsonFile));
    for (const group of target.compileGroups || []) {
      for (const sourceIndex of group.sourceIndexes) {
        const source = path.join(sourceRoot, target.sources[sourceIndex].path);
        compileCommands.push(new CompileCommand(group, source));
      }
    }
  }

  return compileCommands;
}

/**
 * Find path to  EspXEngine.dll as it only exists in host/target bin for MSVC Visual Studio release.
 * @param {ToolchainInfo} toolchain information on the toolchain being used
 * @returns absolute path to EspXEngine.dll
 */
function findEspXEngine(toolchain) {
  const hostDir = path.dirname(path.dirname(toolchain.path));
  const espXEnginePath = path.join(hostDir, toolchain.hostArch, 'EspXEngine.dll');
  if (fs.existsSync(espXEnginePath)) {
    return espXEnginePath;
  }

  throw new Error(`Unable to find: ${espXEnginePath}`);
}

/**
 * Find official ruleset directory using the known path of MSVC compiler in Visual Studio.
 * @param {ToolchainInfo} toolchain information on the toolchain being used
 * @returns absolute path to directory containing all Visual Studio rulesets
 */
function findRulesetDirectory(toolchain) {
  const rulesetDirectory = getRelativeTo(toolchain.path, RelativeRulesetPath);
  return fs.existsSync(rulesetDirectory) ? rulesetDirectory : undefined;
}

/**
 * Find ruleset first searching relative to GitHub repository and then relative to the official ruleset directory
 * shipped in Visual Studio.
 * @param {string} rulesetDirectory path to directory containing all Visual Studio rulesets
 * @returns path to ruleset found locally or inside Visual Studio
 */
function findRuleset(rulesetDirectory) {
  const repoRulesetPath = resolveInputPath("ruleset");
  if (!repoRulesetPath) {
    return undefined;
  } else if (fs.existsSync(repoRulesetPath)) {
    core.info(`Found local ruleset: ${repoRulesetPath}`);
    return repoRulesetPath;
  }

  // search official ruleset directory that ships inside of Visual Studio
  const rulesetPath = core.getInput("ruleset");
  if (rulesetDirectory != undefined) {
    const officialRulesetPath = path.join(rulesetDirectory, rulesetPath);
    if (fs.existsSync(officialRulesetPath)) {
      core.info(`Found official ruleset: ${officialRulesetPath}`);
      return officialRulesetPath;
    }
  } else {
    core.warning("Unable to find official rulesets shipped with Visual Studio.");
  }

  throw new Error(`Unable to find local or official ruleset specified: ${rulesetPath}`);
}

/**
 * Options to enable/disable different compiler features.
 */
function CompilerCommandOptions() {
  // Use /external command line options to ignore warnings in CMake SYSTEM headers.
  this.ignoreSystemHeaders = core.getInput("ignoreSystemHeaders");
  // Toggle whether implicit includes/libs are loaded from Visual Studio Command Prompt
  this.loadImplicitCompilerEnv = core.getInput("loadImplicitCompilerEnv");
  // Ignore analysis on any CMake targets defined in these paths
  this.ignoredTargetPaths = resolveInputPaths("ignoredTargetPaths");
  // Additional include paths to exclude from analysis
  this.ignoredIncludePaths = resolveInputPaths("ignoredIncludePaths")
    .map((include) => new IncludePath(include, true));
  if (this.ignoredIncludePaths && !this.ignoreSystemHeaders) {
    throw new Error("Use of 'ignoredIncludePaths' requires 'ignoreSystemHeaders == true'");
  }
  // Additional arguments to add the command-line of every analysis instance
  this.additionalArgs = core.getInput("additionalArgs");
  // TODO: add support to build precompiled headers before running analysis.
  this.usePrecompiledHeaders = false; // core.getInput("usePrecompiledHeaders");
}

/**
 * Construct all command-line arguments that will be common among all sources files of a given compiler.
 * @param {*} toolchain information on the toolchain being used
 * @param {CompilerCommandOptions} options options for different compiler features
 * @returns list of analyze arguments common to the given toolchain
 */
function getCommonAnalyzeArguments(toolchain, options) {
  const args = ["/analyze:only", "/analyze:quiet", "/analyze:log:format:sarif"];

  const espXEngine = findEspXEngine(toolchain);
  args.push(`/analyze:plugin${espXEngine}`);

  const rulesetDirectory = findRulesetDirectory(toolchain);
  const rulesetPath = findRuleset(rulesetDirectory);
  if (rulesetPath != undefined) {
    args.push(`/analyze:ruleset${rulesetPath}`);

    // add ruleset directories incase user includes any official rulesets
    if (rulesetDirectory != undefined) {
      args.push(`/analyze:rulesetdirectory${rulesetDirectory}`);
    }
  } else {
    core.warning('Ruleset is not being used, all warnings will be enabled.');
  }

  if (options.ignoreSystemHeaders) {
    args.push(`/external:W0`);
    args.push(`/analyze:external-`);
  }

  if (options.additionalArgs) {
    args = args.concat(toolrunner.argStringToArray(options.additionalArgs));
  }

  return args;
}

/**
 * Extract the the implicit includes that should be used with the given compiler from the
 * Visual Studio command prompt corresponding with the toolchain used. This is required
 * as MSVC does not populate the CMake API `toolchain.implicit.includeDirectories` property.
 * @param {ToolchainInfo} toolchain information on the toolchain being used
 * @returns array of default includes used by the given MSVC toolset
 */
async function extractEnvironmentFromCommandPrompt(toolchain) {
  // use bat file to output environment variable required after running 'vcvarsall.bat' 
  const vcEnvScript = path.join(__dirname, "vc_env.bat");
  // init arguments for 'vcvarsall.bat' to match the toolset version/arch used
  const commandPromptPath = getRelativeTo(toolchain.path, RelativeCommandPromptPath);
  const arch = (toolchain.hostArch == toolchain.targetArch) ? 
    toolchain.hostArch : `${toolchain.hostArch}_${toolchain.targetArch}`;

  core.info("Extracting environment from VS Command Prompt");
  const execOptions = { silent: true };
  const execOutput = await exec.getExecOutput(vcEnvScript,
    [commandPromptPath, arch, toolchain.toolsetVersion], execOptions);
  if (execOutput.exitCode != 0) {
    core.debug(execOutput.stdout);
    throw new Error("Failed to run VS Command Prompt to collect implicit includes/libs");
  }

  const env = { INCLUDE: "", LIB: "" };
  for (const line of execOutput.stdout.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index != -1) {
      const envVar = line.substring(0, index);
      if (envVar in env) {
        env[envVar] = line.substring(index + 1);
      }
    }
  }

  return env;
}

/**
 * Construct all environment variables that will be common among all sources files of a given compiler.
 * @param {ToolchainInfo} toolchain information on the toolchain being used
 * @param {CompilerCommandOptions} options options for different compiler features
 * @returns map of environment variables common to the given toolchain
 */
async function getCommonAnalyzeEnvironment(toolchain, options) {
  const env = {
    CAEmitSarifLog: "1", // enable compatibility mode as GitHub does not support some sarif options
    CAExcludePath: process.env.CAExcludePath || "",
    INCLUDE: process.env.INCLUDE || "",
    LIB: process.env.LIB || "",
  };

  if (options.loadImplicitCompilerEnv) {
    const commandPromptEnv = await extractEnvironmentFromCommandPrompt(toolchain);
    env.CAExcludePath += `;${commandPromptEnv.INCLUDE}`; // exclude all implicit includes
    env.INCLUDE += `;${commandPromptEnv.INCLUDE}`;
    env.LIB += `;${commandPromptEnv.LIB}`;
  }

  return env;
}

/**
 * Information required to run analysis on a single source file.
 * @param {string} source absolute path to the source file being compiled
 * @param {string} compiler absolute path to compiler used
 * @param {string[]} args all compilation and analyze arguments to pass to cl.exe
 * @param {[key: string]: string} env environment to use when running cl.exe
 */
function AnalyzeCommand(source, compiler, args, env) {
  this.source = source;
  this.compiler = compiler;
  this.args = args;
  this.env = env;
}

/**
 * Load information needed to compile and analyze each source file in the given CMake project.
 * This makes use of the CMake file API and other sources to collect this data.
 * @param {string} buildRoot absolute path to the build directory of the CMake project
 * @param {string} resultsDir absolute path to the 'results' directory for creating SARIF files
 * @param {CompilerCommandOptions} options options for different compiler features
 * @returns list of information to compile and analyze each source file in the project
 */
async function createAnalysisCommands(buildRoot, resultsDir, options) {
  const replyIndexInfo = await loadCMakeApiReplies(buildRoot);
  const toolchainMap = loadToolchainMap(replyIndexInfo);
  const compileCommands = loadCompileCommands(replyIndexInfo, options.ignoredTargetPaths);

  let commonArgsMap = {};
  let commonEnvMap = {};
  for (const toolchain of Object.values(toolchainMap)) {
    if (!(toolchain.path in commonArgsMap)) {
      commonArgsMap[toolchain.path] = getCommonAnalyzeArguments(toolchain, options);
      commonEnvMap[toolchain.path] = await getCommonAnalyzeEnvironment(toolchain, options);
    }
  }

  let analyzeCommands = []
  for (const command of compileCommands) {
    const toolchain = toolchainMap[command.language];
    if (toolchain) {
      let args = toolrunner.argStringToArray(command.args);
      const allIncludes = toolchain.includes.concat(
        command.includes, options.ignoredIncludePaths);
      for (const include of allIncludes) {
        if (options.ignoreSystemHeaders && include.isSystem) {
          // TODO: filter compilers that don't support /external.
          args.push(`/external:I${include.path}`);
        } else {
          args.push(`/I${include.path}`);
        }
      }

      for (const define of command.defines) {
        args.push(`/D${define}`);
      }

      args.push(command.source);

      const sarifLog = path.join(resultsDir,
        `${path.basename(command.source)}.${analyzeCommands.length}.sarif`);
      args.push(`/analyze:log${sarifLog}`);

      args = args.concat(commonArgsMap[toolchain.path]);
      analyzeCommands.push(new AnalyzeCommand(command.source, toolchain.path, args, commonEnvMap[toolchain.path]));
    }
  }

  return analyzeCommands;
}

/**
 * Get 'results' directory action input and cleanup any stale SARIF files.
 * @returns absolute path to the 'results' directory for creating SARIF files
 */
function prepareResultsDir() {
  const resultsDir = resolveInputPath("resultsDirectory", true);
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true }, err => {
      if (err) {
        throw new Error("Failed to create 'results' directory which did not exist.");
      }
    });
  }

  if (core.getInput('cleanSarif') == 'true') {
    // delete existing Sarif files that are consider stale
    for (const entry of fs.readdirSync(resultsDir, { withFileTypes : true })) {
      if (entry.isFile() && path.extname(entry.name).toLowerCase() == '.sarif') {
        fs.unlinkSync(path.join(resultsDir, entry.name));
      }
    }
  }

  return resultsDir;
}

/**
 * Main
 */
async function main() {
  try {
    const buildDir = resolveInputPath("cmakeBuildDirectory", true);
    if (!fs.existsSync(buildDir)) {
      throw new Error("CMake build directory does not exist. Ensure CMake is already configured.");
    }

    const resultsDir = prepareResultsDir();
    const options = new CompilerCommandOptions();
    const analyzeCommands = await createAnalysisCommands(buildDir, resultsDir, options);
    if (analyzeCommands.length == 0) {
      throw new Error('No C/C++ files were found in the project that could be analyzed.');
    }

    // TODO: parallelism
    for (const command of analyzeCommands) {
      const execOptions = {
        cwd: buildDir,
        env: command.env,
      };

      // TODO: timeouts
      core.info(`Running analysis on: ${command.source}`);
      try {
        await exec.exec(`"${command.compiler}"`, command.args, execOptions);
      } catch (err) {
        core.debug("Environment:");
        core.debug(execOptions.env);
        core.warning(`Compilation failed with error: ${err}`);
      }
    }

  } catch (error) {
    if (core.isDebug()) {
      core.setFailed(error.stack)
    } else {
      core.setFailed(error)
    }
  }
}

if (require.main === module) {
  (async () => {
    await main();
  })();
}