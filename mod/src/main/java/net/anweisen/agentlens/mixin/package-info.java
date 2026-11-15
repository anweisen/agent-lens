/**
 * Injections into the game. Version fragile: every target class and method name is listed in mod/README.md. The
 * mixins hold no logic, they call {@link net.anweisen.agentlens.game.Hooks},
 * {@link net.anweisen.agentlens.capture.Regions} or read {@link net.anweisen.agentlens.game.Scene}.
 */
package net.anweisen.agentlens.mixin;
