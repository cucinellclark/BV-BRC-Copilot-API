/**
 * Path State Service — resolves BV-BRC browser URLs to structured page context.
 *
 * Ported from the Python utilities/state_utils.py + data_utils.py to eliminate
 * the separate Flask utilities process dependency.
 *
 * Given a URL path like "/view/Genome/83332.12#view_tab=overview", this module
 * returns a structured object describing the page type, entity data (fetched
 * from the BV-BRC Solr API), and parsed URL parameters.
 */

'use strict';

const axios = require('axios');
const { createLogger } = require('./logger');

const logger = createLogger('PathStateService');

const SOLR_BASE_URL = 'https://www.bv-brc.org/api/';

// ---------------------------------------------------------------------------
// Solr query helper (replaces data_utils.py)
// ---------------------------------------------------------------------------

/**
 * Query the BV-BRC Solr API.
 * @param {string} endpoint - Solr collection (e.g. "genome", "taxonomy")
 * @param {string} params - Query string (e.g. "eq(genome_id,83332.12)")
 * @returns {Array|null} Array of result objects, or null on error
 */
async function querySolrEndpoint(endpoint, params) {
  const url = `${SOLR_BASE_URL}${endpoint}?${params}`;
  try {
    const response = await axios.get(url, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000
    });
    return response.data;
  } catch (err) {
    logger.warn('Solr query failed', { url, error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL parsing helpers (replaces process_hashtag_section / process_query_section)
// ---------------------------------------------------------------------------

/**
 * Parse a URL fragment (hash) section into key-value pairs.
 * e.g. "view_tab=proteins&filter=active" -> { view_tab: "proteins", filter: "active" }
 */
function parseHashParams(hashSection) {
  if (!hashSection) return {};
  const params = {};
  for (const pair of hashSection.split('&')) {
    if (pair.includes('=')) {
      const [key, ...rest] = pair.split('=');
      params[key] = rest.join('=');
    } else if (pair) {
      params[pair] = true;
    }
  }
  return params;
}

/**
 * Parse a URL query section, handling both standard key=value and complex
 * Solr-style function queries like eq(field,value).
 */
function parseQueryParams(querySection) {
  if (!querySection) return {};
  const params = {};

  // Complex query: starts with function-like syntax (no = before first paren)
  if (querySection.includes('(') && querySection.includes(')') &&
      !querySection.split('(')[0].includes('=')) {
    params.query = querySection;
  } else {
    for (const pair of querySection.split('&')) {
      if (pair.includes('=')) {
        const [key, ...rest] = pair.split('=');
        params[key] = rest.join('=');
      } else if (pair.includes('(') && pair.includes(')')) {
        params.query = pair;
      } else if (pair) {
        params[pair] = true;
      }
    }
  }
  return params;
}

/**
 * Split a path into clean path, hash params, and query params.
 */
function splitPath(path) {
  let cleanPath = path;
  let hashSection = '';
  let querySection = '';

  if (cleanPath.includes('#')) {
    [cleanPath, hashSection] = cleanPath.split('#', 2);
  }
  if (cleanPath.includes('?')) {
    [cleanPath, querySection] = cleanPath.split('?', 2);
  }

  return {
    cleanPath,
    hashtag_params: parseHashParams(hashSection),
    query_params: parseQueryParams(querySection)
  };
}

// ---------------------------------------------------------------------------
// Main dispatcher (replaces get_path_state)
// ---------------------------------------------------------------------------

/**
 * Resolve a BV-BRC URL path to structured page state.
 * @param {string} path - The URL path (e.g. "/view/Genome/83332.12#view_tab=overview")
 * @returns {object} Structured page state
 */
async function getPathState(path) {
  if (path.startsWith('/view'))       return viewPathState(path);
  if (path.startsWith('/searches') || path.startsWith('/search'))
    return searchPathState(path);
  if (path.startsWith('/app'))        return appPathState(path);
  if (path.startsWith('/workspace'))  return workspacePathState(path);
  if (path.startsWith('/job'))        return jobPathState(path);
  if (path.startsWith('/outbreaks'))  return outbreaksPathState(path);

  const aboutPrefixes = [
    '/', '/about', '/brc-calendar', '/publications', '/citation',
    '/related-resources', '/privacy-policy', '/team'
  ];
  if (aboutPrefixes.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p + '#') || path.startsWith(p + '?'))) {
    return aboutPathState(path);
  }

  return { path, status: 'unknown' };
}

// ---------------------------------------------------------------------------
// /view/* handler
// ---------------------------------------------------------------------------

async function viewPathState(path) {
  const { cleanPath, hashtag_params, query_params } = splitPath(path);
  const base = { path, status: 'view', hashtag_params, query_params };

  const remaining = cleanPath.replace(/^\/view\//, '').replace(/\/$/, '');
  const parts = remaining.split('/');
  const viewType = parts[0] || '';
  const entityId = parts[1] || '';

  // Entity types that need Solr queries
  const solrViews = {
    Taxonomy:             { type: 'taxonomy',              collection: 'taxonomy',        field: 'taxon_id' },
    Genome:               { type: 'genome',                collection: 'genome',          field: 'genome_id' },
    Feature:              { type: 'feature',               collection: 'genome_feature',  field: 'feature_id' },
    Epitope:              { type: 'epitope',               collection: 'epitope',         field: 'epitope_id' },
    ExperimentComparison: { type: 'experiment_comparison', collection: 'experiment',      field: 'exp_id' },
  };

  if (solrViews[viewType]) {
    const { type, collection, field } = solrViews[viewType];
    if (entityId) {
      const state = await querySolrEndpoint(collection, `eq(${field},${entityId})`);
      return { ...base, type, state };
    }
    return { ...base, type };
  }

  // Antibiotic — ID is in query params
  if (viewType === 'Antibiotic') {
    const q = query_params.query || '';
    if (q.startsWith('eq(antibiotic_name,') && q.endsWith(')')) {
      const name = q.slice(19, -1);
      const state = await querySolrEndpoint('antibiotics', `eq(antibiotic_name,${name})`);
      return { ...base, type: 'antibiotic', state };
    }
    return { ...base, type: 'antibiotic' };
  }

  // ProteinStructure — accession in hash params
  if (viewType === 'ProteinStructure') {
    if (hashtag_params.accession) {
      const state = await querySolrEndpoint('protein_structure', `eq(pdb_id,${hashtag_params.accession})`);
      return { ...base, type: 'protein_structure', state };
    }
    return { ...base, type: 'protein_structure' };
  }

  // BiosetResult — experiment ID in query params
  if (viewType === 'BiosetResult') {
    const q = query_params.query || '';
    if (q.startsWith('in(exp_id,(') && q.endsWith('))')) {
      const expId = q.slice(11, -2);
      const state = await querySolrEndpoint('experiment', `eq(exp_id,${expId})`);
      return { ...base, type: 'bioset_result', state };
    }
    return { ...base, type: 'bioset_result' };
  }

  // Static view types (no Solr query needed)
  const staticViews = {
    PathwaySummary: { type: 'pathway_summary', state: 'This is the pathway summary view. Use the interactive grid chat in the vertical green bar to interact with the data.' },
    PathwayMap:     { type: 'pathway_map',     state: 'not implemented' },
    GenomeList:     { type: 'genome_list',     state: 'This is the genome list view. Use the interactive grid chat in the vertical green bar to interact with the data.' },
    FeatureList:    { type: 'feature_list',    state: 'This is the feature list view. Use the interactive grid chat in the vertical green bar to interact with the data.' },
    PathwayList:    { type: 'pathway_list',    state: 'This is the pathway list view. Use the interactive grid chat in the vertical green bar to interact with the data.' },
    SubsystemList:  { type: 'subsystem_list',  state: 'This is the subsystem list view. Use the interactive grid chat in the vertical green bar to interact with the data.' },
  };

  if (staticViews[viewType]) {
    return { ...base, ...staticViews[viewType] };
  }

  return { ...base, type: 'unknown' };
}

// ---------------------------------------------------------------------------
// /searches/* handler
// ---------------------------------------------------------------------------

const SEARCH_TYPES = {
  TaxaSearch:             { type: 'taxa_search',              state: 'This is the taxa search page. Users can search for taxonomic information and organisms.' },
  GenomeSearch:           { type: 'genome_search',            state: 'This is the genome search page. Users can search for genome information and sequences.' },
  StrainSearch:           { type: 'strain_search',            state: 'This is the strain search page. Users can search for bacterial strain information.' },
  GenomicFeatureSearch:   { type: 'genomic_feature_search',   state: 'This is the genomic feature search page. Users can search for genes, proteins, and other genomic features.' },
  ProteinSearch:          { type: 'protein_search',           state: 'This is the protein search page. Users can search for protein sequences and information.' },
  SpecialtyGeneSearch:    { type: 'specialty_gene_search',    state: 'This is the specialty gene search page. Users can search for specialty genes like virulence factors, antibiotic resistance genes, etc.' },
  DomainAndMotifSearch:   { type: 'domain_motif_search',      state: 'This is the domain and motif search page. Users can search for protein domains and motifs.' },
  EpitopeSearch:          { type: 'epitope_search',           state: 'This is the epitope search page. Users can search for epitopes and related information.' },
  ProteinStructureSearch: { type: 'protein_structure_search', state: 'This is the protein structure search page. Users can search for 3D protein structures and PDB entries.' },
  PathwaySearch:          { type: 'pathway_search',           state: 'This is the pathway search page. Users can search for metabolic pathways and biochemical processes.' },
  SubsystemSearch:        { type: 'subsystem_search',         state: 'This is the subsystem search page. Users can search for functional subsystems and gene clusters.' },
  SurveillanceSearch:     { type: 'surveillance_search',      state: 'This is the surveillance search page. Users can search for surveillance and epidemiological data.' },
  SerologySearch:         { type: 'serology_search',          state: 'This is the serology search page. Users can search for serological data.' },
  SFVTSearch:             { type: 'sfvt_search',              state: 'This is the SFVT (Sequence Feature Variant Type) search page. Users can search for feature variants.' },
};

function searchPathState(path) {
  const { cleanPath, hashtag_params, query_params } = splitPath(path);
  const base = { path, status: 'search', hashtag_params, query_params };

  const remaining = cleanPath.replace(/^\/search(?:es)?\//, '').replace(/\/$/, '');

  if (SEARCH_TYPES[remaining]) {
    return { ...base, ...SEARCH_TYPES[remaining] };
  }

  const querySection = path.includes('?') ? path.split('?', 2)[1]?.split('#')[0] : '';
  return { ...base, type: 'search_results', state: `This is the search results page. It displays the results of the search query ${querySection}.` };
}

// ---------------------------------------------------------------------------
// /app/* handler
// ---------------------------------------------------------------------------

const APP_TYPES = {
  Assembly2:                     { type: 'assembly',                         state: 'This is the Genome Assembly service. It allows single or multiple assemblers to be invoked to compare results. The service attempts to select the best assembly.' },
  Annotation:                    { type: 'annotation',                       state: 'This is the Genome Annotation service. It provides annotation of genomic features using the RAST tool kit (RASTtk) for bacteria and VIGOR4 for viruses. The service accepts a FASTA formatted contig file and an annotation recipe based on taxonomy to provide an annotated genome.' },
  ComprehensiveGenomeAnalysis:   { type: 'comprehensive_genome_analysis',    state: 'This is the Comprehensive Genome Analysis service. It provides a streamlined analysis "meta-service" that accepts raw reads and performs a comprehensive analysis including assembly, annotation, identification of nearest neighbors, a basic comparative analysis that includes a subsystem summary, phylogenetic tree, and the features that distinguish the genome from its nearest neighbors.' },
  Homology:                      { type: 'homology',                         state: 'This is the BLAST service. It uses BLAST (Basic Local Alignment Search Tool) to search against public or private genomes or other databases using DNA or protein sequence(s).' },
  PrimerDesign:                  { type: 'primer_design',                    state: 'This is the Primer Design service. It utilizes Primer3 to design primers from a given input sequence under a variety of temperature, size, and concentration constraints.' },
  GenomeDistance:                { type: 'genome_distance',                  state: 'This is the Similar Genome Finder service. It will find similar public genomes in BV-BRC or compute genome distance estimation using Mash/MinHash. It returns a set of genomes matching the specified similarity criteria.' },
  GenomeAlignment:               { type: 'genome_alignment',                 state: 'This is the Genome Alignment (Mauve) service. The Whole Genome Alignment Service aligns genomes using progressiveMauve.' },
  Variation:                     { type: 'variation',                        state: 'This is the Variation Analysis service. It can be used to identify and annotate sequence variations.' },
  Tnseq:                         { type: 'tnseq',                            state: 'This is the Tn-Seq Analysis service. It facilitates determination of essential and conditionally essential regions in bacterial genomes from data generated from transposon insertion sequencing (Tn-Seq) experiments.' },
  PhylogeneticTree:              { type: 'phylogenetic_tree',                state: 'This is the Bacterial Genome Tree service. It enables construction of custom phylogenetic trees for user-selected genomes using codon tree method.' },
  ViralGenomeTree:               { type: 'viral_genome_tree',                state: 'This is the Viral Genome Tree service. It enables construction of whole genome alignment based phylogenetic trees for user-selected viral genomes.' },
  GeneTree:                      { type: 'gene_tree',                        state: 'This is the Gene / Protein Tree service. It enables construction of custom phylogenetic trees built from user-selected genes or proteins.' },
  CoreGenomeMLST:                { type: 'core_genome_mlst',                 state: 'This is the Core Genome MLST service. It accepts genome groups and uses them to create and evaluate a core genome through MultiLocus Sequence Typing (MLST). The service uses a software tool called chewBBACA. The list of bacterial species this service supports are available at cgMLST.' },
  WholeGenomeSNPAnalysis:        { type: 'whole_genome_snp_analysis',        state: 'This is the Whole Genome SNP Analysis service. It accepts genome groups and identifies single nucleotide polymorphisms (SNPs) for tracking viral and bacterial pathogens during outbreaks. The software, kSNP4 will identify SNPs and estimate phylogenetic trees based on those SNPs.' },
  MSA:                           { type: 'msa',                              state: 'This is the Multiple Sequence Alignment (MSA) and Single Nucleotide Polymorphism (SNP) / Variation Analysis Service. It allows users to choose an alignment algorithm to align sequences selected from: a search result, a FASTA file saved to the workspace, or through simply cutting and pasting. The service can also be used for variation and SNP analysis with feature groups, FASTA files, aligned FASTA files, and user input FASTA records.' },
  MetaCATS:                      { type: 'metacats',                         state: 'This is the Metadata-driven Comparative Analysis Tool (Meta-CATS). Users can identify positions that significantly differ between user-defined groups of sequences, though biological biases due to covariation, codon biases, and differences in genotype, geography, time of isolation, or others may affect the robustness of the underlying statistical assumptions.' },
  SeqComparison:                 { type: 'proteome_comparison',              state: 'This is the Proteome Comparison service. It performs protein sequence-based genome comparison using bidirectional BLASTP, allowing users to select genomes and compare them to reference genomes.' },
  ComparativeSystems:            { type: 'comparative_systems',              state: 'This is the Comparative Systems service. It allows comparison of protein families, pathways, and subsystems for user-selected genomes.' },
  Docking:                       { type: 'docking',                          state: 'This is the Docking service. It computes a set of docking poses given a protein structure and set of small-molecule ligands.' },
  TaxonomicClassification:       { type: 'taxonomic_classification',         state: 'This is the Taxonomic Classification service. It computes taxonomic classification for read data.' },
  MetagenomicBinning:            { type: 'metagenomic_binning',              state: 'This is the Metagenomic Binning service. It accepts either reads or contigs, and attempts to "bin" the data into a set of genomes. This service can be used to reconstruct bacterial and archael genomes from environmental samples.' },
  MetagenomicReadMapping:        { type: 'metagenomic_read_mapping',         state: 'This is the Metagenomic Read Mapping service. It uses KMA to align reads against antibiotic resistance genes from CARD and virulence factors from VFDB.' },
  Rnaseq:                        { type: 'rnaseq',                           state: 'This is the RNA-Seq Analysis service. It provides services for aligning, assembling, and testing differential expression on RNA-Seq data.' },
  Expression:                    { type: 'expression',                       state: 'This is the Expression Import service. It facilitates upload of user-provided, pre-processed differential expression datasets generated by microarray, RNA-Seq, or proteomic technologies to the user\'s private workspace.' },
  FastqUtil:                     { type: 'fastq_util',                       state: 'This is the Fastq Utilities service. It provides capability for aligning, measuring base call quality, and trimming fastq read files.' },
  IDMapper:                      { type: 'id_mapper',                        state: 'This is the ID Mapper tool. It maps BV-BRC identifiers to those from other prominent external databases such as GenBank, RefSeq, EMBL, UniProt, KEGG, etc. Alternatively, it can map a list of external database identifiers to the corresponding BV-BRC features.' },
  ComprehensiveSARS2Analysis:    { type: 'comprehensive_sars2_analysis',     state: 'This is the SARS-CoV-2 Genome Analysis service. It provides a streamlined "meta-service" that accepts raw reads and performs genome assembly, annotation, and variation analysis.' },
  SARS2Wastewater:               { type: 'sars2_wastewater',                 state: 'This is the SARS-CoV-2 Wastewater Analysis service. It assembles raw reads with the Sars One Codex pipeline and performs variant analysis with Freyja.' },
  SequenceSubmission:            { type: 'sequence_submission',              state: 'This is the Sequence Submission service. It allows user to validate and submit virus sequences to NCBI Genbank. User-provided metadata and FASTA sequences are validated against the Genbank data submission standards to identify any sequence errors before submission. Sequences are also annotated using the VIGOR4 and FLAN annotation tools for internal use by users. The service provides a validation report that should be reviewed by the user before submitting the sequences to Genbank.' },
  HASubtypeNumberingConversion:  { type: 'ha_subtype_numbering_conversion',  state: 'This is the HA Subtype Numbering Conversion service. It allows user to renumber Influenza HA sequences according to a cross-subtype numbering scheme proposed by Burke and Smith in Burke DF, Smith DJ.2014. A recommended numbering scheme for influenza A HA subtypes. PLoS One 9:e112302. Burke and Smith\'s numbering scheme uses analysis of known HA structures to identify amino acids that are structurally and functionally equivalent across all HA subtypes, using a numbering system based on the mature HA sequence.' },
  SubspeciesClassification:      { type: 'subspecies_classification',        state: 'This is the Subspecies Classification tool. It assigns the genotype/subtype of a virus, based on the genotype/subtype assignments maintained by the International Committee on Taxonomy of Viruses (ICTV). This tool infers the genotype/subtype for a query sequence from its position within a reference tree. The service uses the pplacer tool with a reference tree and reference alignment and includes the query sequence as input. Interpretation of the pplacer result is handled by Cladinator.' },
  TreeSort:                      { type: 'tree_sort',                        state: 'This is the TreeSort tool. It infers both recent and ancestral reassortment events along the branches of a phylogenetic tree of a fixed genomic segment. It uses a statistical hypothesis testing framework to identify branches where reassortment with other segments has occurred and reports these events.' },
  ViralAssembly:                 { type: 'viral_assembly',                   state: 'This is the Viral Assembly service. It utilizes IRMA (Iterative Refinement Meta-Assembler) to assemble viral genomes. Users must select the virus genome for processing.' },
};

function appPathState(path) {
  const { cleanPath, hashtag_params, query_params } = splitPath(path);
  const base = { path, status: 'app', hashtag_params, query_params };

  const remaining = cleanPath.replace(/^\/app\//, '').replace(/\/$/, '');

  if (APP_TYPES[remaining]) {
    return { ...base, ...APP_TYPES[remaining] };
  }
  return { ...base, type: 'unknown' };
}

// ---------------------------------------------------------------------------
// /outbreaks/* handler
// ---------------------------------------------------------------------------

const OUTBREAK_TYPES = {
  Measles:  { type: 'measles',   state: 'This is the Measles outbreak tracking page. Measles is a highly contagious viral disease that spreads through respiratory droplets, primarily affecting areas with low vaccination coverage. The page tracks current outbreaks including the recent Texas outbreak that has spread to multiple states, driven by low vaccination rates.' },
  Mpox:     { type: 'mpox',      state: 'This is the Mpox (Monkeypox) outbreak tracking page. Monitors the global spread of MPXV with over 99,176 confirmed cases across 117 countries. Tracks both Clade I (more pathogenic, Central Africa) and Clade II.b (global outbreak since 2022) variants, including recent concerning spread of Clade I outside traditional geographic ranges.' },
  H5N1:     { type: 'h5n1',      state: 'This is the H5N1 Avian Influenza outbreak tracking page. Monitors the ongoing H5N1 outbreak that began in 2020, spreading across continents through migrating birds. Tracks human infections (26 cases globally Jan 2022-April 2024), including recent dairy farm worker cases, and monitors viral evolution for mammalian adaptation markers.' },
  SARSCoV2: { type: 'sars_cov2', state: 'This is the SARS-CoV-2 Variants and Lineages of Concern tracking page. Provides real-time monitoring of COVID-19 variants through daily processing of sequences, risk assessment of emerging variants, and interactive dashboards showing variant prevalence across countries and regions over time.' },
};

function outbreaksPathState(path) {
  const { cleanPath, hashtag_params, query_params } = splitPath(path);
  const base = { path, status: 'outbreaks', hashtag_params, query_params };

  const remaining = cleanPath.replace(/^\/outbreaks\/?/, '').replace(/\/$/, '');

  if (!remaining) {
    return { ...base, type: 'mea', state: 'This is the outbreaks page. It displays a list of outbreaks.' };
  }
  if (OUTBREAK_TYPES[remaining]) {
    return { ...base, ...OUTBREAK_TYPES[remaining] };
  }
  return { ...base, type: 'unknown', state: 'This is an outbreak page for an unknown outbreak type.' };
}

// ---------------------------------------------------------------------------
// /workspace/* handler
// ---------------------------------------------------------------------------

function workspacePathState(path) {
  const { cleanPath, hashtag_params, query_params } = splitPath(path);
  const base = { path, status: 'workspace', hashtag_params, query_params };

  const remaining = cleanPath.replace(/^\/workspace\//, '').replace(/\/$/, '');
  const parts = remaining.split('/');

  if (parts.length >= 1 && parts[0]) {
    const owner = parts[0];
    const subpath = parts.slice(1).join('/');

    if (owner === 'public') {
      return { ...base, type: 'public_workspace', owner, subpath, state: 'This is a public workspace that provides shared access to data, analysis results, and collaborative research materials. Public workspaces are accessible by any registered user and contain datasets and tools shared by the community.' };
    }
    return { ...base, type: 'private_workspace', owner, subpath, state: 'This is a private workspace that provides a private area for uploading data, running analysis services, storing analysis results, and managing groups of data. The workspace contains folders for experiments, genome groups, feature groups, and job results.' };
  }
  return { ...base, type: 'workspace_root', state: 'This is the workspace root directory. Workspaces provide private areas for uploading data, running analysis services, and managing research data and results.' };
}

// ---------------------------------------------------------------------------
// /job/* handler
// ---------------------------------------------------------------------------

function jobPathState(path) {
  const { cleanPath, hashtag_params, query_params } = splitPath(path);
  const base = { path, status: 'job', hashtag_params, query_params };

  if (cleanPath === '/job' || cleanPath === '/job/') {
    return { ...base, type: 'job_status_page', state: 'This is the Job Status page that provides a list of all submitted jobs. It shows information including job status (queued, running, completed, or failed), submission time, service type, output name, start time, and completion time. Users can view job results, kill running jobs, or report issues with failed jobs. Jobs are created when analysis services run on back-end HPC systems.' };
  }
  return { ...base, type: 'unknown' };
}

// ---------------------------------------------------------------------------
// /about, /, and other static pages handler
// ---------------------------------------------------------------------------

const ABOUT_PAGES = {
  '/about':             { type: 'about',             state: 'This is the About BV-BRC page. The Bacterial and Viral Bioinformatics Resource Center (BV-BRC) is an information system designed to support the biomedical research community\'s work on bacterial and viral infectious diseases via integration of vital pathogen information with rich data and analysis tools. BV-BRC combines the data, technology, and extensive user communities from PATRIC (bacterial system) and IRD/ViPR (viral systems). It is led by Rick Stevens (University of Chicago) and Elliot Lefkowitz (University of Alabama at Birmingham), and is funded by the National Institute of Allergy and Infectious Diseases under Grant No. U24AI183849.' },
  '/':                  { type: 'home',              state: 'This is the BV-BRC home page. BV-BRC (Bacterial and Viral Bioinformatics Resource Center) provides integrated access to bacterial and viral pathogen data, analysis tools, and resources. It combines PATRIC and IRD/ViPR databases with hundreds of thousands of bacterial genomes and over a million viral genomes, supporting comparative bioinformatics, large-scale data analysis, and machine learning for infectious disease research.' },
  '':                   { type: 'home',              state: 'This is the BV-BRC home page. BV-BRC (Bacterial and Viral Bioinformatics Resource Center) provides integrated access to bacterial and viral pathogen data, analysis tools, and resources. It combines PATRIC and IRD/ViPR databases with hundreds of thousands of bacterial genomes and over a million viral genomes, supporting comparative bioinformatics, large-scale data analysis, and machine learning for infectious disease research.' },
  '/brc-calendar':      { type: 'brc_calendar',      state: 'This is the BRC Calendar page. The calendar provides a consolidated view of events, such as webinars and workshops, across three BRCs: BV-BRC, BRC Analytics, and Pathogen Data Network. Users can view upcoming events, access additional details by clicking on events, and add events to their personal calendars. This centralized calendar helps the research community stay informed about educational opportunities and collaborative events across the broader BRC ecosystem.' },
  '/publications':      { type: 'publications',      state: 'This is the Publications page. Complete lists of publications by BV-BRC resource can be found at Google Scholar. This page provides access to scientific publications and research papers that have utilized BV-BRC resources, helping users discover relevant literature and understand how the platform has contributed to infectious disease research.' },
  '/citation':          { type: 'citation',           state: 'This is the Citing BV-BRC Resources page. It provides proper citation information for researchers using BV-BRC, PATRIC, IRD, or ViPR web resources in publications or proposals. The page includes specific citation formats for each resource, acknowledgment text for grant funding, and contact information (help@bv-brc.org) for notifying the team about accepted publications that cite BV-BRC resources.' },
  '/related-resources': { type: 'related_resources',  state: 'This is the Related Resources page. It provides links to complementary bioinformatics resources including other Bioinformatics Resource Centers (BRC Analytics, Pathogen Data Network), NIAID programs, and external databases and tools relevant to infectious disease research. Resources include NCBI, GISAID, CDC, WHO, KBase, KEGG, and specialized databases like IEDB and ViralZone.' },
  '/privacy-policy':    { type: 'privacy_policy',     state: 'This is the Privacy Policy page. It describes how BV-BRC collects, stores, uses, and protects personal information and research data. The policy covers user account information, data sharing controls, usage analytics, and security measures. BV-BRC is committed to maintaining confidentiality and never collects information for commercial purposes. Users can control their data sharing and have access to edit or remove their personal information.' },
  '/team':              { type: 'team',               state: 'This is the BV-BRC Team page listing the project team members across four partner organizations. The team includes members from the University of Chicago/Argonne National Laboratory/FIG (led by Co-Principal Investigator Rick Stevens), J. Craig Venter Institute (led by Site Principal Investigator Indresh Singh), Biocomplexity Institute and Initiative at University of Virginia, and University of Alabama at Birmingham (led by Co-Principal Investigator Elliot Lefkowitz). The page displays the collaborative structure and expertise that makes BV-BRC possible.' },
};

function aboutPathState(path) {
  const { cleanPath, hashtag_params, query_params } = splitPath(path);
  const base = { path, status: 'about', hashtag_params, query_params };

  // Normalize trailing slash
  const normalized = cleanPath.replace(/\/$/, '') || '/';

  if (ABOUT_PAGES[normalized]) {
    const page = ABOUT_PAGES[normalized];
    // Override status for home page
    if (page.type === 'home') {
      return { ...base, status: 'home', ...page };
    }
    return { ...base, ...page };
  }
  return { ...base, type: 'unknown' };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getPathState,
  querySolrEndpoint,
  // Exposed for testing
  parseHashParams,
  parseQueryParams,
  splitPath,
};
