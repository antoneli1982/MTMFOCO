# Planejamento de projetos

Na tela inicial, clique em **📊 Planejamento** para consultar os planejamentos e criar um independente. Para vincular um planejamento a um projeto, abra a empresa e clique em **＋ Novo planejamento** no cartão do projeto.

Selecione as folhas que compõem o processo e informe a quantidade de cada atividade. O tempo total é a soma de **tempo padrão da folha × quantidade**, em segundos e minutos. O cálculo usa o mesmo tempo padrão exibido no editor atual. É possível incluir folhas de outros projetos, ordenar as atividades e informar o takt e os recursos, como no módulo anterior.

Os planejamentos vinculados são salvos dentro do projeto, pelo salvamento já existente. Os independentes permanecem no navegador, na chave histórica `mtm_process_plans_independent_v1`; use **Backup** ou **Salvar Tudo** para transportá-los. Os arquivos antigos continuam compatíveis, e planejamentos que ainda estiverem nos dados locais ou nos projetos voltam a aparecer.

A restauração recupera o módulo de consolidação da revisão `1297f36dff6a486bf61571409789cab91a51ffb5`, anterior à remoção em `362bb76`. Preserva a interface e as fórmulas da versão atual. A importação e a duplicação atualizam os vínculos das folhas e suas quantidades; exportações individuais também incluem folhas externas utilizadas pelos planejamentos.

## Verificação

Com Node.js e Playwright disponíveis, execute `node tests/planejamento.cjs`. Para usar um navegador já instalado, defina `PLAYWRIGHT_EXECUTABLE_PATH` com seu caminho. O teste usa dados fictícios e bloqueia conexões externas, inclusive com o Firebase. Confere cálculos, seleção, quantidades, recursos, reabertura, planejamentos independentes, duplicação, exportação, importação nos modos substituir e mesclar, importação pela empresa, backup, exclusão sem apagar folhas e layout móvel.

## Ocupação planejada por turno (opcional)

O bloco separado permite cadastrar identificadores de postos e turnos, ID opcional da pessoa (não exige nomes), capacidade líquida em segundos e volumes de cada atividade no turno. A carga usa o tempo padrão vigente da folha vezes esse volume, independentemente da quantidade por ciclo do planejamento. O percentual é carga atribuída / capacidade líquida, sem modificar o dimensionamento por takt nem reaplicar percentuais/descontos.

O mesmo ID da pessoa no mesmo turno compartilha uma única capacidade e soma as cargas de todos os postos desse planejamento. Capacidades divergentes, turno vazio, folhas ausentes, quantidades inválidas ou posições sem atribuição bloqueiam o percentual. Não há consolidação entre planejamentos; períodos devem ser não sobrepostos. Distribua os volumes entre postos para não repetir o trabalho. O resultado é planejado, não medição individual nem recomendação final de pessoal, cadência ou segurança.

Os campos opcionais ficam no próprio plano; planos antigos não são migrados. A importação/duplicação remapeia os vínculos das atividades. O relatório inclui o cenário e suas ressalvas. Teste adicional sem navegador: `node tests/ocupacao-planejada.cjs`.
