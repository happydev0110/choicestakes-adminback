import type {
  PlayerFilters,
  GameFilters,
  PlayerUpdate,
  GameUpdate,
} from "./schemas.js";
export interface Player {
  id: string;
  email: string;
  displayName: string;
  status: string;
  emailVerified: boolean;
  createdAt: string;
}
export interface PlayerDetails extends Player {
  activeSessions: number;
}
export interface Game {
  uuid: string;
  name: string;
  provider: string;
  vendor: string;
  code: string;
  currency: string;
  imageUrl: string | null;
  available: boolean;
  visible: boolean;
  categories: string[];
  syncedAt: string;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}
export interface GamePage extends Page<Game> {
  currency: string;
  providers: string[];
  categories: readonly string[];
  sync: {
    status: string;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    providerTotal: number | null;
    errorCode: string | null;
  } | null;
}
export interface ManagementStore {
  players(filters: PlayerFilters): Promise<Page<Player>>;
  player(id: string): Promise<PlayerDetails | null>;
  updatePlayer(id: string, input: PlayerUpdate, actorId: string): Promise<void>;
  games(filters: GameFilters): Promise<GamePage>;
  game(id: string): Promise<Game | null>;
  updateGame(id: string, input: GameUpdate, actorId: string): Promise<void>;
}
