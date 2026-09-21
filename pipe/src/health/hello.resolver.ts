import { Query, Resolver } from '@nestjs/graphql';
import { Public } from '../common/public.decorator';

@Resolver()
export class HelloResolver {
  @Query(() => String, { name: 'hello' })
  @Public()
  hello(): string {
    return 'Hello from GraphQL';
  }
}
