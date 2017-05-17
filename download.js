/*global require, module*/
import { join as j } from "path";
import { tmpdir } from "os";
import { gitClone, npmDownloadArchive, untar, gitSpecFromVersion } from "./util.js";
import { PackageSpec } from "./package-map.js";
import semver from "./deps/semver.min.js"
import { resource } from "./deps/lively.resources.js"

export {
  packageDownload
}


function maybeFileResource(url) {
  if (typeof url === "string" && url.startsWith("/"))
      url = "file://" + url;
  return url.isResource ? url : resource(url);
}

function pathForNameAndVersion(nameAndVersion, destinationDir) {
  // pathForNameAndVersion("foo-bar@1.2.3", "file:///x/y")
  // pathForNameAndVersion("foo-bar@foo/bar", "file:///x/y")
  // pathForNameAndVersion("foo-bar@git+https://github.com/foo/bar#master", "file:///x/y")

  let [name, version] = nameAndVersion.split("@"),
      gitSpec = gitSpecFromVersion(version);

  // "git clone -b my-branch git@github.com:user/myproject.git"
  return gitSpec ?
    Object.assign({}, gitSpec, {location: null, name, version: gitSpec.gitURL}) :
    {location: null, name, version};
}


async function packageDownload(packageNameAndRange, destinationDir, verbose, attempt = 0) {
  // packageNameAndRange like "lively.modules@^0.7.45"
  // if no @ part than we assume @*

  try {

    destinationDir = maybeFileResource(destinationDir);

    if (!packageNameAndRange.includes("@")) {
      // any version
      packageNameAndRange += "@*";
    }

    // download package to tmp location
    let tmp = resource("file://" + tmpdir()).join("package_install_tmp/");
    await tmp.ensureExistance()

    let pathSpec = pathForNameAndVersion(packageNameAndRange, destinationDir.path()),
        downloadDir = pathSpec.gitURL
          ? await packageDownloadViaGit(pathSpec, tmp, verbose)
          : await packageDownloadViaNpm(packageNameAndRange, tmp, verbose);


    let packageJSON = downloadDir.join("package.json"), config;
    if (!await packageJSON.exists())
      throw new Error(`Downloaded package ${packageNameAndRange} does not have a package.json file at ${packageJSON}`);

    config = await packageJSON.readJson();
    let packageDir;
    if (pathSpec.gitURL) {
      let dirName = config.name + "/" + pathSpec.versionInFileName;
      packageDir = maybeFileResource(destinationDir).join(dirName).asDirectory();
    } else {
      let dirName = config.name + "/" + config.version;
      packageDir = destinationDir.join(dirName).asDirectory();
      pathSpec = Object.assign({}, pathSpec, {location: packageDir});
    }

    await addNpmSpecificConfigAdditions(
      packageJSON, config, packageNameAndRange, pathSpec.gitURL);

    await downloadDir.rename(packageDir);

    let packageSpec = PackageSpec.fromDir(packageDir.path());
    packageSpec.writeLvInfo(Object.assign({build: false}, pathSpec));

    return packageSpec;

  } catch (err) {
    if (attempt >= 3) {
      console.error(`Download of ${packageNameAndRange} failed:`, err.stack);
      throw err;
    }
    console.log(`[flatn] retrying download of ${packageNameAndRange}`);
    return packageDownload(packageNameAndRange, destinationDir, verbose, attempt+1);
  }
}


async function packageDownloadViaGit({gitURL: url, name, branch}, targetDir, verbose) {
  // packageNameAndRepo like "lively.modules@https://github.com/LivelyKernel/lively.modules"
  branch = branch || "master"
  url = url.replace(/#[^#]+$/, "");
  let dir = targetDir.join(name).asDirectory()
  await gitClone(url, dir, branch);
  return dir;
}

async function packageDownloadViaNpm(packageNameAndRange, targetDir, verbose) {
  // packageNameAndRange like "lively.modules@^0.7.45"
  // if no @ part than we assume @*
  let {
    downloadedArchive,
    name, version
  } = await npmDownloadArchive(packageNameAndRange, targetDir, verbose);
  return untar(downloadedArchive, targetDir, name);
}

function addNpmSpecificConfigAdditions(configFile, config, packageNameAndRange, gitURL) {
  // npm adds some magic "_" properties to the package.json. There is no
  // specification of it and the official stance is that it is npm internal but
  // some packages depend on that. In order to allow npm scripts like install to
  // work smoothly we add a subset of those props here.
    let [_, version] = packageNameAndRange.split("@"),
        _id = gitURL ?
          packageNameAndRange :
          `${config.name}@${config.version}`,
        _from = gitURL ?
          `${config.name}@${gitURL}` :
          `${config.name}@${semver.validRange(version)}`;
    return configFile.writeJson(Object.assign({_id, _from}, config), true);
}
