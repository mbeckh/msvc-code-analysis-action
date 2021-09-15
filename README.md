# msvc-code-analysis-action

This actions run code analysis for any CMake project built with the Microsoft Visual C++ Compiler. The analysis
will produce SARIF results that can be uploaded to the GitHub Code Scanning Alerts experience and/or included as
artifacts to view locally in the Sarif Viewer for VSCode.

## Usage

### Pre-requisites

Include a workflow `.yml` file using an [example](#example) below as a template. Run the `msvc-code-analysis-action`
after configuring CMake for your project. Building the project is only required if the C++ source files involve the use
of generated files.


### Input Parameters

Description of all input parameters: [action.yml](https://github.com/microsoft/msvc-code-analysis-action/blob/redesign/action.yml)

### Example

```yml
env:
  build: '${{ github.workspace }}/build'
  results: ${{ github.workspace }}/build/results

jobs:
  build:
    steps:
      # Configure project with CMake
      - name: Configure CMake
        uses: lukka/run-cmake@v3
        with:
          buildDirectory: ${{ env.build }}
          # Build is not require unless generated source files are used
          buildWithCMake: false
          cmakeGenerator: 'VS16Win64'
          cmakeListsTxtPath: ${{ github.workspace }}/CMakeLists.txt

      # Run Microsoft Visual C++ code analysis
      - name: Initialize MSVC Code Analysis 
        uses: microsoft/msvc-code-analysis-action
        with:
          cmakeBuildDirectory: ${{ env.build }}
          resultsDirectory: ${{ env.results }}
          # Ruleset file that will determine what checks will be run
          ruleset: NativeRecommendRules.ruleset

      # Upload all SARIF files to GitHub Code Scanning Alerts
      - name: Upload SARIF to Github
        uses: github/codeql-action/upload-sarif@v1
        with:
          sarif_file: ${{ env.results }}

      # Upload all SARIF files as Artifacts to download and view
      - name: Upload SARIF as Artifacts
        uses: actions/upload-artifact@v2
        with:
          name: sarif-files
          path: ${{ env.results }}
```

## Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft 
trademarks or logos is subject to and must follow 
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
