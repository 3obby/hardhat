import type LodashCloneDeepT from "lodash.clonedeep";
import type {
  CompilationJob,
  CompilerInput,
  DependencyGraph,
} from "hardhat/types";

import chalk from "chalk";
import { extendConfig, subtask, task, types } from "hardhat/config";
import { isFullyQualifiedName } from "hardhat/utils/contract-names";
import {
  TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
  TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT,
  TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
} from "hardhat/builtin-tasks/task-names";
import {
  TASK_VERIFY,
  TASK_VERIFY_ETHERSCAN_ATTEMPT_VERIFICATION,
  TASK_VERIFY_ETHERSCAN_GET_CONTRACT_INFORMATION,
  TASK_VERIFY_ETHERSCAN_GET_MINIMAL_INPUT,
  TASK_VERIFY_GET_VERIFICATION_SUBTASKS,
  TASK_VERIFY_RESOLVE_ARGUMENTS,
  TASK_VERIFY_VERIFY,
  TASK_VERIFY_ETHERSCAN,
  TASK_VERIFY_PRINT_SUPPORTED_NETWORKS,
  TASK_VERIFY_SOURCIFY,
  TASK_VERIFY_SOURCIFY_DISABLED_WARNING,
} from "./internal/task-names";
import {
  etherscanConfigExtender,
  sourcifyConfigExtender,
} from "./internal/config";
import {
  MissingAddressError,
  InvalidAddressError,
  InvalidContractNameError,
  InvalidConstructorArgumentsError,
  InvalidLibrariesError,
  CompilerVersionsMismatchError,
  ContractNotFoundError,
  BuildInfoNotFoundError,
  BuildInfoCompilerVersionMismatchError,
  DeployedBytecodeMismatchError,
  UnexpectedNumberOfFilesError,
  VerificationAPIUnexpectedMessageError,
  ContractVerificationFailedError,
  HardhatVerifyError,
} from "./internal/errors";
import {
  sleep,
  encodeArguments,
  getCompilerVersions,
  printSupportedNetworks,
  resolveConstructorArguments,
  resolveLibraries,
  printVerificationErrors,
} from "./internal/utilities";
import { Etherscan } from "./internal/etherscan";
import { Bytecode } from "./internal/solc/bytecode";
import {
  ContractInformation,
  ExtendedContractInformation,
  extractInferredContractInformation,
  extractMatchingContractInformation,
  getLibraryInformation,
  LibraryToAddress,
} from "./internal/solc/artifacts";

import "./internal/type-extensions";

// Main task args
interface VerifyTaskArgs {
  address?: string;
  constructorArgsParams: string[];
  constructorArgs?: string;
  libraries?: string;
  contract?: string;
  listNetworks: boolean;
}

// verify:verify subtask args
interface VerifySubtaskArgs {
  address?: string;
  constructorArguments: string[];
  libraries: LibraryToAddress;
  contract?: string;
}

// parsed verification args
interface VerificationArgs {
  address: string;
  constructorArgs: string[];
  libraries: LibraryToAddress;
  contractFQN?: string;
}

interface GetContractInformationArgs {
  contractFQN?: string;
  deployedBytecode: Bytecode;
  matchingCompilerVersions: string[];
  libraries: LibraryToAddress;
}

interface GetMinimalInputArgs {
  sourceName: string;
}

interface AttemptVerificationArgs {
  address: string;
  compilerInput: CompilerInput;
  contractInformation: ExtendedContractInformation;
  verificationInterface: Etherscan;
  encodedConstructorArguments: string;
}

interface VerificationResponse {
  success: boolean;
  message: string;
}

extendConfig(etherscanConfigExtender);
extendConfig(sourcifyConfigExtender);

/**
 * Main verification task.
 *
 * This is a meta-task that gets all the verification tasks and runs them.
 * Right now there's only a "verify-etherscan" task.
 */
task(TASK_VERIFY, "Verifies a contract on Etherscan")
  .addOptionalPositionalParam("address", "Address of the contract to verify")
  .addOptionalVariadicPositionalParam(
    "constructorArgsParams",
    "Contract constructor arguments. Cannot be used if the --constructor-args option is provided",
    []
  )
  .addOptionalParam(
    "constructorArgs",
    "Path to a Javascript module that exports the constructor arguments",
    undefined,
    types.inputFile
  )
  .addOptionalParam(
    "libraries",
    "Path to a Javascript module that exports a dictionary of library addresses. " +
      "Use if there are undetectable library addresses in your contract. " +
      "Library addresses are undetectable if they are only used in the contract constructor",
    undefined,
    types.inputFile
  )
  .addOptionalParam(
    "contract",
    "Fully qualified name of the contract to verify. Skips automatic detection of the contract. " +
      "Use if the deployed bytecode matches more than one contract in your project"
  )
  .addFlag("listNetworks", "Print the list of supported networks")
  .setAction(async (taskArgs: VerifyTaskArgs, { run }) => {
    if (taskArgs.listNetworks) {
      await run(TASK_VERIFY_PRINT_SUPPORTED_NETWORKS);
      return;
    }

    const verificationSubtasks: string[] = await run(
      TASK_VERIFY_GET_VERIFICATION_SUBTASKS
    );

    const errors: Record<string, HardhatVerifyError> = {};
    let hasErrors = false;
    for (const verificationSubtask of verificationSubtasks) {
      try {
        await run(verificationSubtask, taskArgs);
      } catch (error) {
        hasErrors = true;
        errors[verificationSubtask] = error as HardhatVerifyError;
      }
    }

    if (hasErrors) {
      printVerificationErrors(errors);
      process.exit(1);
    }
  });

subtask(
  TASK_VERIFY_GET_VERIFICATION_SUBTASKS,
  async (_, { config }): Promise<string[]> => {
    const verificationSubtasks = [];

    if (config.etherscan.enabled) {
      verificationSubtasks.push(TASK_VERIFY_ETHERSCAN);
    }

    if (config.sourcify.enabled) {
      verificationSubtasks.push(TASK_VERIFY_SOURCIFY);
    } else {
      verificationSubtasks.push(TASK_VERIFY_SOURCIFY_DISABLED_WARNING);
    }

    if (!config.etherscan.enabled && !config.sourcify.enabled) {
      console.warn(
        chalk.yellow(
          `WARNING: No verification services are enabled. Please enable at least one verification service in your configuration.`
        )
      );
    }

    return verificationSubtasks;
  }
);

subtask(TASK_VERIFY_SOURCIFY_DISABLED_WARNING, async (): Promise<void> => {
  console.warn(
    chalk.yellow(
      `WARNING: Skipping Sourcify verification: Sourcify is disabled. To enable it, add this entry to your config:

sourcify: {
enabled: true
}

Learn more at https://...`
    )
  );
});

/**
 * Main Etherscan verification subtask.
 *
 * Verifies a contract in Etherscan by coordinating various subtasks related
 * to contract verification.
 */
subtask(TASK_VERIFY_ETHERSCAN)
  .addParam("address")
  .addOptionalParam("constructorArgsParams", undefined, undefined, types.any)
  .addOptionalParam("constructorArgs")
  // TODO: [remove-verify-subtask] change to types.inputFile
  .addOptionalParam("libraries", undefined, undefined, types.any)
  .addOptionalParam("contract")
  .addFlag("listNetworks")
  .setAction(async (taskArgs: VerifyTaskArgs, { config, network, run }) => {
    const {
      address,
      constructorArgs,
      libraries,
      contractFQN,
    }: VerificationArgs = await run(TASK_VERIFY_RESOLVE_ARGUMENTS, taskArgs);

    const chainConfig = await Etherscan.getCurrentChainConfig(
      network.name,
      network.provider,
      config.etherscan.customChains
    );

    const etherscan = Etherscan.fromChainConfig(
      config.etherscan.apiKey,
      chainConfig
    );

    const isVerified = await etherscan.isVerified(address);
    if (isVerified) {
      const contractURL = etherscan.getContractUrl(address);
      console.log(`The contract ${address} has already been verified.
${contractURL}`);
      return;
    }

    const configCompilerVersions = await getCompilerVersions(config.solidity);

    const deployedBytecode = await Bytecode.getDeployedContractBytecode(
      address,
      network.provider,
      network.name
    );

    const matchingCompilerVersions = await deployedBytecode.getMatchingVersions(
      configCompilerVersions
    );
    // don't error if the bytecode appears to be OVM bytecode, because we can't infer a specific OVM solc version from the bytecode
    if (matchingCompilerVersions.length === 0 && !deployedBytecode.isOvm()) {
      throw new CompilerVersionsMismatchError(
        configCompilerVersions,
        deployedBytecode.getVersion(),
        network.name
      );
    }

    const contractInformation: ExtendedContractInformation = await run(
      TASK_VERIFY_ETHERSCAN_GET_CONTRACT_INFORMATION,
      {
        contractFQN,
        deployedBytecode,
        matchingCompilerVersions,
        libraries,
      }
    );

    const minimalInput: CompilerInput = await run(
      TASK_VERIFY_ETHERSCAN_GET_MINIMAL_INPUT,
      {
        sourceName: contractInformation.sourceName,
      }
    );

    const encodedConstructorArguments = await encodeArguments(
      contractInformation.contractOutput.abi,
      contractInformation.sourceName,
      contractInformation.contractName,
      constructorArgs
    );

    // First, try to verify the contract using the minimal input
    const { success: minimalInputVerificationSuccess }: VerificationResponse =
      await run(TASK_VERIFY_ETHERSCAN_ATTEMPT_VERIFICATION, {
        address,
        compilerInput: minimalInput,
        contractInformation,
        verificationInterface: etherscan,
        encodedConstructorArguments,
      });

    if (minimalInputVerificationSuccess) {
      return;
    }

    console.log(`We tried verifying your contract ${contractInformation.contractName} without including any unrelated one, but it failed.
Trying again with the full solc input used to compile and deploy it.
This means that unrelated contracts may be displayed on Etherscan...
`);

    // If verifying with the minimal input failed, try again with the full compiler input
    const {
      success: fullCompilerInputVerificationSuccess,
      message: verificationMessage,
    }: VerificationResponse = await run(
      TASK_VERIFY_ETHERSCAN_ATTEMPT_VERIFICATION,
      {
        address,
        compilerInput: contractInformation.compilerInput,
        contractInformation,
        verificationInterface: etherscan,
        encodedConstructorArguments,
      }
    );

    if (fullCompilerInputVerificationSuccess) {
      return;
    }

    throw new ContractVerificationFailedError(
      verificationMessage,
      contractInformation.undetectableLibraries
    );
  });

subtask(TASK_VERIFY_RESOLVE_ARGUMENTS)
  .addOptionalParam("address")
  .addOptionalParam("constructorArgsParams", undefined, [], types.any)
  .addOptionalParam("constructorArgs", undefined, undefined, types.inputFile)
  // TODO: [remove-verify-subtask] change to types.inputFile
  .addOptionalParam("libraries", undefined, undefined, types.any)
  .addOptionalParam("contract")
  .setAction(
    async ({
      address,
      constructorArgsParams,
      constructorArgs: constructorArgsModule,
      contract,
      libraries: librariesModule,
    }: VerifyTaskArgs): Promise<VerificationArgs> => {
      if (address === undefined) {
        throw new MissingAddressError();
      }

      const { isAddress } = await import("@ethersproject/address");
      if (!isAddress(address)) {
        throw new InvalidAddressError(address);
      }

      if (contract !== undefined && !isFullyQualifiedName(contract)) {
        throw new InvalidContractNameError(contract);
      }

      const constructorArgs = await resolveConstructorArguments(
        constructorArgsParams,
        constructorArgsModule
      );

      // TODO: [remove-verify-subtask] librariesModule should always be string
      let libraries;
      if (typeof librariesModule === "object") {
        libraries = librariesModule;
      } else {
        libraries = await resolveLibraries(librariesModule);
      }

      return {
        address,
        constructorArgs,
        libraries,
        contractFQN: contract,
      };
    }
  );

subtask(TASK_VERIFY_ETHERSCAN_GET_CONTRACT_INFORMATION)
  .addParam("deployedBytecode", undefined, undefined, types.any)
  .addParam("matchingCompilerVersions", undefined, undefined, types.any)
  .addParam("libraries", undefined, undefined, types.any)
  .addOptionalParam("contractFQN")
  .setAction(
    async (
      {
        contractFQN,
        deployedBytecode,
        matchingCompilerVersions,
        libraries,
      }: GetContractInformationArgs,
      { network, artifacts }
    ): Promise<ExtendedContractInformation> => {
      let contractInformation: ContractInformation | null;

      if (contractFQN !== undefined) {
        let artifactExists;
        try {
          artifactExists = await artifacts.artifactExists(contractFQN);
        } catch (error) {
          artifactExists = false;
        }

        if (!artifactExists) {
          throw new ContractNotFoundError(contractFQN);
        }

        const buildInfo = await artifacts.getBuildInfo(contractFQN);
        if (buildInfo === undefined) {
          throw new BuildInfoNotFoundError(contractFQN);
        }

        if (
          !matchingCompilerVersions.includes(buildInfo.solcVersion) &&
          !deployedBytecode.isOvm()
        ) {
          throw new BuildInfoCompilerVersionMismatchError(
            contractFQN,
            deployedBytecode.getVersion(),
            deployedBytecode.hasVersionRange(),
            buildInfo.solcVersion,
            network.name
          );
        }

        contractInformation = extractMatchingContractInformation(
          contractFQN,
          buildInfo,
          deployedBytecode
        );

        if (contractInformation === null) {
          throw new DeployedBytecodeMismatchError(network.name, contractFQN);
        }
      } else {
        contractInformation = await extractInferredContractInformation(
          artifacts,
          network,
          matchingCompilerVersions,
          deployedBytecode
        );
      }

      // map contractInformation libraries
      const libraryInformation = await getLibraryInformation(
        contractInformation,
        libraries
      );

      return {
        ...contractInformation,
        ...libraryInformation,
      };
    }
  );

subtask(TASK_VERIFY_ETHERSCAN_GET_MINIMAL_INPUT)
  .addParam("sourceName")
  .setAction(async ({ sourceName }: GetMinimalInputArgs, { run }) => {
    const cloneDeep = require("lodash.clonedeep") as typeof LodashCloneDeepT;
    const dependencyGraph: DependencyGraph = await run(
      TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
      { sourceNames: [sourceName] }
    );

    const resolvedFiles = dependencyGraph
      .getResolvedFiles()
      .filter((resolvedFile) => resolvedFile.sourceName === sourceName);

    if (resolvedFiles.length !== 1) {
      throw new UnexpectedNumberOfFilesError();
    }

    const compilationJob: CompilationJob = await run(
      TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
      {
        dependencyGraph,
        file: resolvedFiles[0],
      }
    );

    const minimalInput: CompilerInput = await run(
      TASK_COMPILE_SOLIDITY_GET_COMPILER_INPUT,
      {
        compilationJob,
      }
    );

    return cloneDeep(minimalInput);
  });

subtask(TASK_VERIFY_ETHERSCAN_ATTEMPT_VERIFICATION)
  .addParam("address")
  .addParam("compilerInput", undefined, undefined, types.any)
  .addParam("contractInformation", undefined, undefined, types.any)
  .addParam("verificationInterface", undefined, undefined, types.any)
  .addParam("encodedConstructorArguments")
  .setAction(
    async ({
      address,
      compilerInput,
      contractInformation,
      verificationInterface,
      encodedConstructorArguments,
    }: AttemptVerificationArgs): Promise<VerificationResponse> => {
      // Ensure the linking information is present in the compiler input;
      compilerInput.settings.libraries = contractInformation.libraries;

      const { message: guid } = await verificationInterface.verify(
        address,
        JSON.stringify(compilerInput),
        `${contractInformation.sourceName}:${contractInformation.contractName}`,
        `v${contractInformation.solcLongVersion}`,
        encodedConstructorArguments
      );

      console.log(`Successfully submitted source code for contract
${contractInformation.sourceName}:${contractInformation.contractName} at ${address}
for verification on the block explorer. Waiting for verification result...
`);

      // Compilation is bound to take some time so there's no sense in requesting status immediately.
      await sleep(700);
      const verificationStatus =
        await verificationInterface.getVerificationStatus(guid);

      if (!(verificationStatus.isFailure() || verificationStatus.isSuccess())) {
        // Reaching this point shouldn't be possible unless the API is behaving in a new way.
        throw new VerificationAPIUnexpectedMessageError(
          verificationStatus.message
        );
      }

      if (verificationStatus.isSuccess()) {
        const contractURL = verificationInterface.getContractUrl(address);
        console.log(`Successfully verified contract ${contractInformation.contractName} on the block explorer.
${contractURL}`);
      }

      return {
        success: verificationStatus.isSuccess(),
        message: verificationStatus.message,
      };
    }
  );

/**
 * This subtask is used for backwards compatibility.
 * TODO [remove-verify-subtask]: if you're going to remove this subtask,
 * update TASK_VERIFY_ETHERSCAN and TASK_VERIFY_RESOLVE_ARGUMENTS accordingly
 */
subtask(TASK_VERIFY_VERIFY)
  .addOptionalParam("address")
  .addOptionalParam("constructorArguments", undefined, [], types.any)
  .addOptionalParam("libraries", undefined, {}, types.any)
  .addOptionalParam("contract")
  .setAction(
    async (
      { address, constructorArguments, libraries, contract }: VerifySubtaskArgs,
      { run }
    ) => {
      // This can only happen if the subtask is invoked from within Hardhat by a user script or another task.
      if (!Array.isArray(constructorArguments)) {
        throw new InvalidConstructorArgumentsError();
      }

      if (typeof libraries !== "object" || Array.isArray(libraries)) {
        throw new InvalidLibrariesError();
      }

      await run(TASK_VERIFY_ETHERSCAN, {
        address,
        constructorArgsParams: constructorArguments,
        libraries,
        contract,
      });
    }
  );

subtask(
  TASK_VERIFY_PRINT_SUPPORTED_NETWORKS,
  "Prints the supported networks list"
).setAction(async ({}, { config }) => {
  await printSupportedNetworks(config.etherscan.customChains);
});
