import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { requireAdmin, assertAdminMutation } from "../auth/routes.js";
import { AuthError, type AuthStore } from "../auth/types.js";
import {
  playerFilters,
  gameFilters,
  playerUpdate,
  gameUpdate,
} from "./schemas.js";
import type { ManagementStore } from "./types.js";
export async function registerManagementRoutes(
  app: FastifyInstance,
  config: Config,
  authStore: AuthStore,
  store: ManagementStore,
) {
  await app.register(
    async (api) => {
      api.addHook("onRequest", async (request) => {
        assertAdminMutation(request, config);
        await requireAdmin(request, config, authStore);
      });
      const id = (value: string) => {
        const parsed = z.string().uuid().safeParse(value);
        if (!parsed.success)
          throw new AuthError(400, "INVALID_ID", "Invalid record ID.");
        return parsed.data.toLowerCase();
      };
      api.get("/players", async (request) => {
        const filters = playerFilters.safeParse(request.query);
        if (!filters.success)
          throw new AuthError(
            400,
            "INVALID_FILTERS",
            "Invalid player filters.",
          );
        return { success: true, data: await store.players(filters.data) };
      });
      api.get<{ Params: { id: string } }>("/players/:id", async (request) => {
        const player = await store.player(id(request.params.id));
        if (!player)
          throw new AuthError(404, "PLAYER_NOT_FOUND", "Player not found.");
        return { success: true, data: player };
      });
      api.patch<{ Params: { id: string } }>("/players/:id", async (request) => {
        const input = playerUpdate.safeParse(request.body);
        if (!input.success)
          throw new AuthError(
            400,
            "INVALID_PLAYER",
            "Use a display name of 2–30 characters and an allowed account status.",
          );
        const actor = await requireAdmin(request, config, authStore);
        await store.updatePlayer(id(request.params.id), input.data, actor.id);
        return { success: true, data: { saved: true } };
      });
      api.get("/games", async (request) => {
        const filters = gameFilters.safeParse(request.query);
        if (!filters.success)
          throw new AuthError(400, "INVALID_FILTERS", "Invalid game filters.");
        return { success: true, data: await store.games(filters.data) };
      });
      api.get<{ Params: { id: string } }>("/games/:id", async (request) => {
        const game = await store.game(id(request.params.id));
        if (!game)
          throw new AuthError(404, "GAME_NOT_FOUND", "Game not found.");
        return { success: true, data: game };
      });
      api.patch<{ Params: { id: string } }>("/games/:id", async (request) => {
        const input = gameUpdate.safeParse(request.body);
        if (!input.success)
          throw new AuthError(
            400,
            "INVALID_GAME",
            "Choose valid, unique categories and a visibility setting.",
          );
        const actor = await requireAdmin(request, config, authStore);
        await store.updateGame(id(request.params.id), input.data, actor.id);
        return { success: true, data: { saved: true } };
      });
    },
    { prefix: "/api/admin" },
  );
}
