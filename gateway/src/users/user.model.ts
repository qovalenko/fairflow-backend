// Plain response shapes for the users REST endpoint (UsersController).
// Previously GraphQL @ObjectType models; gateway is REST-only now.
export interface UserModel {
  id: string;
  login: string;
  email: string;
  name: string | null;
  isActive: boolean;
  createdAt: Date;
}

export interface UsersListResult {
  list: UserModel[];
  total: number;
}
