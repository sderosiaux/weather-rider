# WEATHER RIDER

> « Turbulence isn't the enemy. It's the terrain. »

On ne cherche plus à éviter la turbulence. On apprend à la surfer. Le ciel devient une montagne invisible, et le jeu ressemble à du ski dans le ciel.

## 1. Fantasme central

La météo contient des courants tridimensionnels : updraft, downdraft, jet stream, wind shear, thermal, wake turbulence. Le joueur s'en sert pour déplacer son avion efficacement.

Exemple : tu approches d'un gros système orageux. Tu peux le contourner, ou prendre le courant ascendant sur son flanc.

```
aircraft
   ↗
 ↑ ↑ ↑ updraft
████████ storm
```

Tu gagnes 8 000 pieds gratuitement. Tu attrapes ensuite un jet stream : ground speed 847 km/h. Tu arrives en ayant brûlé très peu de carburant.

Une mauvaise trajectoire coûte cher :

```
bad trajectory → violent turbulence → passenger fear → aircraft stress
```

## 2. Contrôles

Physiques et satisfaisants. Souris, clavier ou stick : pitch, roll, yaw, throttle. Pas 90 boutons.

L'air est visible grâce à des particules. Les mouvements atmosphériques apparaissent comme des filaments :

```
~~~~~~~~~~>
   ~~~~~~~~>
      ~~~~~~>
```

Ce qui était invisible devient du terrain.

## 3. Deux objectifs en tension

- efficiency
- comfort

On peut jouer safe, ou traverser les systèmes météo pour battre des records.

## 4. Scoring

| Critère | Mesure |
|---|---|
| Arrival time | temps de vol jusqu'à la porte d'arrivée |
| Fuel consumed | carburant brûlé |
| Passenger comfort | intégrale de l'inconfort (accélération verticale, jerk) |
| Aircraft stress | dépassements de facteur de charge, fatigue cumulée |
| Weather utilization | part de l'énergie gagnée venant de l'atmosphère plutôt que du moteur |

Trois communautés émergent, avec des classements séparés :

- **Smooth Pilots** : 0 turbulence sévère
- **Speedrunners** : vol le plus rapide
- **Eco Pilots** : carburant minimum

## 5. Progression

turboprop → regional jet → narrow body → wide body → cargo → supersonic → experimental

Chaque type change réellement le gameplay :

- Petit avion : sensibilité météo ↑, manœuvrabilité ↑
- Gros avion : inertie ↑, confort ↑, manœuvrabilité ↓

## 6. Hangar

Un trophée visuel : tous tes avions y sont exposés. On débloque instruments, radars, ailes, moteurs, cabine, livrées, avioniques.

Règle absolue : jamais `pay_more = win`. Une modification déplace un compromis, elle n'ajoute pas de puissance brute. Exemple : des winglets réduisent la traînée mais augmentent la sensibilité aux rafales.

## 7. Network effect : seeds et ghosts

Le ciel est défini par une seed partageable. Quelqu'un trouve une route dingue :

```
JFK → LIS
4h51
Fuel remaining: 6%
Extreme weather
```

Il partage « Beat my Atlantic run ». Son trajet apparaît comme un ghost pendant ton vol : tu vois ses décisions et tu essaies de le dépasser.

```
        ghost
          ✈
       ↗
      /
 ✈ you
```

C'est le mécanisme social le plus fort du jeu.

## 8. Daily Weather

`WORLD WEATHER #184` : chaque jour, la même météo procédurale pour tout le monde, trois routes, des classements séparés. Les meilleurs trajets restent visibles sous forme de lignes dans le ciel.

## 9. Direction artistique

Contemplative. Le ciel occupe 95 % de l'écran. L'avion est petit, les nuages gigantesques. Les flux atmosphériques ressemblent à des filaments, des rubans, de la poussière, des vagues, des aurores. Pas de cockpit réaliste : quelques instruments flottants très discrets.

---

## 10. Décisions d'architecture

Ce que le code ne peut pas dire seul.

**Stack.** TypeScript strict, Vite, Three.js, Vitest. Jeu 100 % navigateur, pas de backend au MVP.

**Déterminisme.** Toute la simulation (météo, rafales, dynamique de vol) est pure et dérivée d'une seed, avec un pas fixe de 1/60 s. Sans ça, ni la daily weather ni les ghosts ne tiennent. `Math.random()` est interdit dans `src/weather`, `src/flight`, `src/scoring`.

**Échelle du monde.** Unités en mètres et secondes, repère Three.js : x = est (axe principal des routes), y = haut, z = sud. Une route fait 80 à 160 km de jeu, soit un vol de 6 à 12 minutes réelles. Le temps et la distance « réels » affichés (JFK → LIS en 4h51) sont obtenus par un facteur d'échelle propre à chaque route, pas par la simulation. Plafond de jeu : 14 000 m. Les courants sont amplifiés par rapport au réel (updraft de 10 à 30 m/s) pour que la météo soit du terrain et non du bruit.

**Ghosts.** On enregistre des échantillons d'état (position, orientation) à 10 Hz, pas les inputs. Un ghost reste rejouable même si la dynamique de vol évolue entre deux versions. Partage via URL encodée, sans serveur.

**Leaderboards.** Locaux (localStorage) au MVP. Un classement mondial exige un backend et une validation anti-triche des ghosts ; c'est hors périmètre tant que le cœur du jeu n'est pas fun.

**Ce que mesurent les classements.** Chaque board est normalisé par avion : 1000 veut dire « bien piloter cet avion sans lire le ciel » (ligne droite plein gaz pour speed, croisière économique pour eco, trim direct pour smooth). On ne dépasse 1000 qu'en lisant la météo. Une référence commune à tous les avions aurait donné le board speed au supersonique d'office, donc `pay_more = win`.

**Le jet est un choix latéral, pas vertical.** Les mesures du lab (2 352 vols headless) ont montré qu'un jet à 10 km ne paie jamais sur des routes de 80 à 160 km : la montée et la redescente mangent tout le gain. Il y a donc un jet bas (4 à 5,5 km, l'altitude où l'on vole déjà), décalé de 9 à 13 km de la ligne droite, en plus du jet haut. Le détour devient la décision.

**La géométrie d'une route ne dépend pas de l'avion.** Les ghosts se courent d'un avion à l'autre dans le même ciel. La durée de vol varie donc selon l'avion ; c'est sa vitesse de croisière qu'on règle, pas la route.

**Réglages sous contrôle du lab.** `pnpm lab` mesure la promesse du jeu : le pilote qui lit le ciel doit battre le pilote naïf sur speed et eco dans plus de 70 % des cas en météo modérée ou extrême, un vol direct doit arriver avec 10 à 30 % de carburant, et aucun avion ne doit dominer un board. Toute retouche de constante dans weather, flight, meta ou scoring repasse par ce banc. L'historique des essais est dans `lab/reports/balance-loop.md`.

**Parallélisme du développement.** Les contrats entre modules vivent dans `src/core/types.ts` et sont gelés pendant une vague. Chaque module a un propriétaire unique et un répertoire unique. Chaque module est développable seul, grâce aux fixtures de `src/core/fixtures/` et à sa page sandbox. Aucun agent n'attend un autre agent.

## 11. Hors périmètre MVP

Backend, leaderboards mondiaux, anti-triche, multijoueur temps réel, monétisation.
