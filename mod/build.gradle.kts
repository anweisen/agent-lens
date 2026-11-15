plugins {
  java
}

group = "net.anweisen.agentlens"

// 26.x is unobfuscated, so nothing needs remapping: the mod compiles straight against the client jar and the
// libraries the agent-lens launcher downloaded (run "agent-lens mc install" first). No Loom.
val cache = file(
  providers.gradleProperty("agentLensCache").orNull
    ?: providers.environmentVariable("AGENT_LENS_CACHE").orNull
    ?: ((System.getenv("XDG_CACHE_HOME") ?: "${System.getProperty("user.home")}/.cache") + "/agent-lens")
)
val minecraft: String by project

dependencies {
  compileOnly(files(cache.resolve("versions/$minecraft/$minecraft.jar")))
  compileOnly(fileTree(cache.resolve("libraries")) { include("**/*.jar") })
}

java {
  toolchain.languageVersion = JavaLanguageVersion.of(25)
}

tasks.withType<JavaCompile> {
  options.encoding = "UTF-8"
  options.release = 25
}

tasks.processResources {
  inputs.property("version", project.version)
  filesMatching("fabric.mod.json") {
    expand("version" to project.version)
  }
}

tasks.jar {
  archiveBaseName = "lens"
}
