package net.anweisen.agentlens.api;

import net.anweisen.agentlens.http.ApiServer;

public final class Api {

  private Api() {
  }

  public static void register(ApiServer server) {
    server.get("/status", GameApi::status);
    server.postShared("/quit", GameApi::quit);
    server.post("/settings", GameApi::settings);
    server.post("/resourcepack", ResourcePackApi::resourcePack);

    server.post("/singleplayer", WorldApi::singleplayer);
    server.post("/connect", WorldApi::connect);
    server.post("/disconnect", WorldApi::disconnect);
    server.post("/wait", WorldApi::waitFor);
    server.post("/chat", WorldApi::chat);

    server.get("/screen", ScreenApi::screen);
    server.get("/regions", ScreenApi::regions);
    server.get("/texts", ScreenApi::texts);
    server.get("/hud", HudApi::hud);
    server.post("/hover", ScreenApi::hover);
    server.post("/click", ScreenApi::click);
    server.post("/key", ScreenApi::key);
    server.post("/type", ScreenApi::type);

    server.post("/look", PlayerApi::look);
    server.post("/camera", PlayerApi::camera);
    server.post("/use", PlayerApi::use);
    server.post("/attack", PlayerApi::attack);
    server.post("/hotbar", PlayerApi::hotbar);

    server.post("/capture", CaptureApi::capture);
    server.post("/frames", FramesApi::frames);
    server.postShared("/compose", FramesApi::compose);
    server.post("/record", RecordApi::record);
  }
}
